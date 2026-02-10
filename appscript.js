
function start(data) {
  // 1mb5vfU0l_VR3p3KtAVx47PNwdxDB9Y1i AUTO ZONE

  scanFoldersForPDFs()
  
  const props = PropertiesService.getScriptProperties();
  let queue = getQueuedPDFs();
  console.log('processQueuedPDFs:', queue)

  queue.forEach(pdf => {
    if (pdf.status !== 'QUEUED') return;

    try {
      Logger.log(`Processing ${pdf}`); 

      const pdfFile = DriveApp.getFileById(pdf.fileId);

      const root = DriveApp.getFolderById(ROOT_PROJECT_FOLDER_ID);
      const projectFolder = root.createFolder(
        `${'Proposal'}_${Date.now()}`,
      );

      const geminiResponse = sendPdfToGemini(pdfFile);
      console.log('geminiResponse', geminiResponse);
      // {site_plan_page_number=6.0, total_linear_footage=626.56 LF, total_camera_count=3.0}
      //  totalLinearFootage
      // totalCameraCount
      // sitePlanPageNumber
      const artifacts = projectFolder.createFolder('Artifacts');
      const logs = projectFolder.createFolder('Logs');

      // // 2. Upload PDF to Cloud Storage
      const gcsUri = uploadPdfToGCS(pdfFile, GCS_BUCKET_NAME);

      const selectedPages = [{ page: geminiResponse.sitePlanPageNumber }];

      // 6. Rasterize selected pages only
      const images = rasterizeSelectedPages(
        gcsUri,
        selectedPages,
        artifacts,
      );
      if (!images || !images[0] || !images[0].fileId) {
        throw new Error('No image found from document', images);
      }
      const nenoResponse = callNanoBanana(projectFolder, images[0].fileId);

      generateDocument(projectFolder, nenoResponse, geminiResponse);

      persistArtifacts(artifacts, images);

      pdf.status = 'PROCESSED';
      pdf.processedAt = new Date().toISOString();

    } catch (err) {
      pdf.status = 'ERROR';
      pdf.error = err.toString();
    }
  });

  props.setProperty('PDF_QUEUE', JSON.stringify(queue));
}


// --- PDF folder scan



function scanFoldersForPDFs() {

  const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const subFolders = parentFolder.getFolders();

  let pdfQueue = [];

  while (subFolders.hasNext()) {
    const folder = subFolders.next();
    const folderName = folder.getName().toLowerCase();

    // Skip folders containing "rc"
    if (folderName.includes(EXCLUDED_NAME)) continue;

    const files = folder.getFilesByType(MimeType.PDF);

    while (files.hasNext()) {
      const file = files.next();

      pdfQueue.push({
        folderId: folder.getId(),
        folderName: folder.getName(),
        fileId: file.getId(),
        fileName: file.getName(),
        fileUrl: file.getUrl(),
        queuedAt: new Date().toISOString(),
        status: 'QUEUED'
      });
    }
  }

  savePDFQueue(pdfQueue);
}

function savePDFQueue(pdfQueue) {
  console.log('savePDFQueue:', pdfQueue);
  if (!pdfQueue.length) return;

  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('PDF_QUEUE');

  let storedQueue = existing ? JSON.parse(existing) : [];

  // Avoid duplicates (by fileId)
  const existingIds = new Set(storedQueue.map(p => p.fileId));
  const newItems = pdfQueue.filter(p => !existingIds.has(p.fileId));

  storedQueue = storedQueue.concat(newItems);

  props.setProperty('PDF_QUEUE', JSON.stringify(storedQueue));
}

function getQueuedPDFs() {
  const props = PropertiesService.getScriptProperties();
  const data = props.getProperty('PDF_QUEUE');
  return data ? JSON.parse(data) : [];
}
 
// End of PDF folder scan
function extractPdfPages(pdfFile, outputFolder) {
  const url = `https://www.googleapis.com/drive/v3/files/${pdfFile.getId()}/export?mimeType=image/png`;

  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const blob = response.getBlob();
  const file = outputFolder.createFile(blob).setName('page_1.png');

  return [file]; // Extend for multi-page via Drive API batch
}

function runVisionDetection(imageFiles) {
  return imageFiles.map((file) => {
    const image = VisionApp.annotateImage({
      image: { content: Utilities.base64Encode(file.getBlob().getBytes()) },
      features: [{ type: 'TEXT_DETECTION' }],
    });
    return {
      fileId: file.getId(),
      textScore: image.textAnnotations?.length || 0,
    };
  });
}

function selectBestSheet(images, visionResults) {
  visionResults.sort((a, b) => b.textScore - a.textScore);
  return images.find((img) => img.getId() === visionResults[0].fileId);
}

function annotateSheet(imageFile, folder) {
  // Placeholder – real annotation uses Canvas API or external service
  return folder.createFile(imageFile.getBlob()).setName('annotated.png');
}

function generateProposal(folder, data) {
  const template = DriveApp.getFileById(PROPOSAL_TEMPLATE_DOC_ID);
  const doc = template.makeCopy(`Proposal - ${data.projectName}`, folder);
  const body = DocumentApp.openById(doc.getId()).getBody();

  body.replaceText('{{PROJECT_NAME}}', data.projectName);
  body.replaceText('{{LOCATION}}', data.location);
  body.replaceText('{{CLIENT}}', data.client);
  body.replaceText('{{BID_REF}}', data.bidRef || 'N/A');

  return doc;
}

function uploadPdfToGCS(pdfFile, bucketName) {
  const fileName = cleanPdfFileName(pdfFile.getName());
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(fileName)}`;

  const response = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
      'Content-Type': 'application/pdf',
    },
    payload: pdfFile.getBlob().getBytes(),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`GCS upload failed: ${response.getContentText()}`);
  }
  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
  // return `gs://${bucketName}/${fileName}`;
}

function rasterizePage(pdfGcsUri, pageNumber) {
  console.log(pdfGcsUri, pageNumber);
  const response = UrlFetchApp.fetch(CLOUD_RUN_RASTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({ pdf: pdfGcsUri, page: pageNumber }),
  });
  console.log(response);
  return Utilities.newBlob(response.getBlob().getBytes(), 'image/png', 'final_image.png');
}
function rasterizeSelectedPages(pdfUri, pages, artifactsFolder) {
  console.log(pdfUri);
  return pages.map((p) => {
    const blob = rasterizePage(pdfUri, p.page);
    const file = artifactsFolder.createFile(blob)
      .setName(`page_${p.page}.png`);

    return {
      page: p.page,
      blob,
      fileId: file.getId(),
      ocrText: p.text,
    };
  });
}

function persistArtifacts(folder, images) {
  images.forEach((img, i) => {
    folder.createFile(
      `page_${img.page}_gemini.json`,
      JSON.stringify('ok', null, 2),
      MimeType.PLAIN_TEXT,
    );
  });
}

function sendPdfToGemini(pdfFile) {
  console.log('sendPdfToGemini');
  const geminiFileName = uploadPdfToGemini(pdfFile);

  const props = PropertiesService.getScriptProperties();
  props.setProperty('status', 'Sending PDF to Gemini with Prompt');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = `
  Act as a Senior Construction Estimator. Review the attached drawings (specifically the Demolition or Civil Site plans).

Task 1: Identify the "Limit of Disturbance" (LOD) or Security Fencing line.
Task 2: Locate the scale bar on that specific page.
Task 3: Calculate the total Linear Footage (LF) of this security perimeter.
Task 4: Calculate the required number of security cameras based on a spacing of one camera every 300 LF. Round up to the nearest whole number.

Output Requirement:
1. State the Total Linear Footage.
2. State the Total Camera Count needed.
3. Identify exactly which page number contains the Site Plan I need to use for the next step.
4. Any client information like email, client name, company name, project name, site address
  Respond ONLY with valid JSON variables:
  totalLinearFootage
  totalCameraCount
  sitePlanPageNumber
  email
  clientName
  companyName
  siteAddress
  
  `;

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        {
          fileData: {
            mimeType: pdfFile.getMimeType(),
            fileUri: `https://generativelanguage.googleapis.com/v1beta/${geminiFileName}`,
          },
        },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
    },
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  return extractGeminiJson(
    JSON.parse(res.getContentText()),
  );
}

function extractGeminiJson(response) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('status', 'Extracting Gemini response');
  console.log(response);
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error('No Gemini response text');
  }
  Logger.log(JSON.parse(text));
  try {
    return JSON.parse(text);
  } catch (e) {
    // Fallback: extract JSON block
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid JSON from Gemini');
    return JSON.parse(match[0]);
  }
}

function uploadPdfToGemini(pdfFile) {
  const uploadUri = createGeminiUploadSession(pdfFile);

  const props = PropertiesService.getScriptProperties();
  props.setProperty('status', 'Uploading PDF to Gemini');

  const res = UrlFetchApp.fetch(uploadUri, {
    method: 'post',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Type': 'application/pdf',
    },
    payload: pdfFile.getBlob().getBytes(),
    muteHttpExceptions: true,
  });

  const text = res.getContentText();
  Logger.log(`Status: ${res.getResponseCode()}`);
  Logger.log(`Body: ${text}`);

  if (res.getResponseCode() !== 200) {
    throw new Error(`Upload failed: ${text}`);
  }
  const json = JSON.parse(text);
  return json.file.name;
}

function createGeminiUploadSession(pdfFile) {
  const bytes = pdfFile.getBlob().getBytes();
  const fileSize = bytes.length;

  const res = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
    {
      method: 'post',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Type': 'application/pdf',
        'X-Goog-Upload-Header-Content-Length': String(fileSize),
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify({
        file: {
          displayName: cleanPdfFileName(pdfFile.getName()),
        },
      }),
      muteHttpExceptions: true,
    },
  );

  const uploadUrl = res.getHeaders()['X-Goog-Upload-URL']
    || res.getHeaders()['x-goog-upload-url'];

  if (!uploadUrl) {
    Logger.log(res.getContentText());
    throw new Error('No upload URL returned');
  }
  return uploadUrl;
}

// GENERATE THE PROPOSAL
function generateDocument(folderLocation, nenoResp, geminiResponse) {
  const fileName = 'Generated Proposal Document';
  Logger.log(folderLocation);
  // === COPY TEMPLATE ===
  const templateFile = DriveApp.getFileById(PROPOSAL_TEMPLATE_DOC_ID);
  const destinationFolder = DriveApp.getFolderById(folderLocation.getId());

  const copiedFile = templateFile.makeCopy(fileName, destinationFolder);

  Logger.log(copiedFile.getId());
  let doc;
  for (let i = 0; i < 3; i++) {
    try {
      doc = DocumentApp.openById(copiedFile.getId());
      break;
    } catch (e) {
      Utilities.sleep(1000);
    }
  }

  if (!doc) {
    throw new Error('Failed to open document after copy');
  }
  const body = doc.getBody();

  const found = body.findText('{{TABLE}}');

  if (!found) {
  // get pricing form Spreadsheet
    const tablesData = SpreadsheetApp
      .openById(SAMPLE_PRICING_SHEET_ID)
      .getSheetByName('Sheet1').getDataRange()
      .getDisplayValues();
    // Ensure it's always 2-D
    if (!Array.isArray(tablesData[0])) {
      tablesData = [tablesData];
    }

    const text = found.getElement().asText();
    const paragraph = text.getParent().asParagraph();
    const index = body.getChildIndex(paragraph);
    console.log('asdf', index);
    console.log('tablesData', tablesData);
    // remove placeholder
    text.deleteText(found.getStartOffset(), found.getEndOffsetInclusive());
    const normalizedData = tablesData.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : cell.toString())));

    // insert table right after the paragraph
    body.insertTable(index + 1, normalizedData);
  } else {
    console.log('Placeholder {{TABLE}} not found');
  }

  // ============== Spreadsheet

  // === REPLACE TEXT PLACEHOLDERS ===
  // body.replaceText('{{NAME}}', 'John Doe');
  body.replaceText('{{DATE}}', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/DD/YYYY'));
  body.replaceText('{{email}}', geminiResponse.email);
  body.replaceText('{{CLIENT_NAME}}', geminiResponse.clientName || '');
  body.replaceText('{{PROJECT_NAME}}', geminiResponse.projectName || '');
  body.replaceText('{{SITE_ADDRESS}}', geminiResponse.siteAddress || '');

  // body.replaceText('{{DESCRIPTION}}', 'This document was generated automatically.');

  // === INSERT IMAGE AT PLACEHOLDER ===
  insertImageAtPlaceholder(body, '{{CAMERA_IMAGE}}', nenoResp.nanoImageId);

  // === SAVE ===
  doc.saveAndClose();
}

function insertImageAtPlaceholder(body, placeholder, imageFileId) {
  const imageBlob = DriveApp.getFileById(imageFileId).getBlob();

  const found = body.findText(placeholder);
  if (!found) {
    throw new Error(`Image placeholder not found: ${placeholder}`);
  }

  const element = found.getElement();
  const parent = element.getParent();
  const text = element.asText();

  // Get index of placeholder
  const startOffset = found.getStartOffset();
  const endOffset = found.getEndOffsetInclusive();

  // Remove placeholder text
  text.deleteText(startOffset, endOffset);

  // Insert image right after placeholder position
  if (parent.getType() === DocumentApp.ElementType.PARAGRAPH) {
    parent.asParagraph().insertInlineImage(0, imageBlob);
  } else {
    parent.getParent().insertInlineImage(parent.getParent().getChildIndex(parent) + 1, imageBlob);
  }
}

function cleanPdfFileName(fileName) {
  // Separate name and extension
  const ext = fileName.toLowerCase().endsWith('.pdf') ? '.pdf' : '';
  let name = ext ? fileName.slice(0, -4) : fileName;

  // Remove special characters
  name = name.replace(/[^a-zA-Z0-9 _-]/g, '');

  // Replace spaces with underscores
  name = name.replace(/\s+/g, '_');

  // Remove multiple underscores or dashes
  name = name.replace(/[_-]{2,}/g, '_');

  // Trim underscores/dashes from start & end
  name = name.replace(/^[_-]+|[_-]+$/g, '');

  // Fallback name if empty
  if (!name) {
    name = 'file';
  }

  return name + ext;
}

function callNanoBanana(projectFolder, fileId) {
  // 2) Prompt for the image edit/generation
  const promptText = `Annotate the construction perimeter for temporary fencing and camera coverage.
ANNOTATION INSTRUCTIONS:
1. PERIMETER LINE
- Trace the dashed "LIMIT OF DISTURBANCE" (LOD) boundary with a solid red line (6 px thickness)
- Ensure the red line precisely follows the dashed LOD line on the plan
- Maintain line clarity over lighter background elements
2. CAMERA BOX MARKERS
- Add red square markers (~16 px) at:
- NW corner (likely pedestrian access gate near parking/street)
- NE corner (eastern property line intersection)
- SE corner (service driveway or staging zone)
- SW corner (main entrance/driveway)
- Any visible gates, driveways, or utility pads
3. INFILL MARKERS
- Place additional red camera markers every ~350 linear feet along the LOD path
- Measure spacing along the boundary line, not straight-line distances
- Ensure visual balance and full coverage of the perimeter
4. STYLE
- Offset each marker ~10 px outward from the perimeter to avoid overlap
- Do not place markers over text, scale bar, or north arrow
- Do not apply decorative shadows or glows—keep clean and professional
OUTPUT:
- Final image must show complete red perimeter line
- All camera markers clearly visible and evenly spaced
- Must be suitable for direct inclusion in a professional client proposal
`;

  const file = DriveApp.getFileById(fileId);
  const sourceBlob = file.getBlob();
  const encodedImage = Utilities.base64Encode(sourceBlob.getBytes());

  // 4) Build the Nano Banana (Gemini) request payload
  const payload = {
    // The `contents` list can accept text and inline image data
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: sourceBlob.getContentType(),
              data: encodedImage,
            },
          },
          {
            text: promptText,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'], // ask for image output
    },
  };

  // 5) Send request
  const response = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    },
  );
  const resultJson = JSON.parse(response.getContentText());

  console.log(resultJson);
  // Step 1: candidates check (valid API response)
  if (!resultJson.candidates || !resultJson.candidates.length) {
    throw new Error(
      `No candidates returned.\n${
        JSON.stringify(resultJson, null, 2)}`,
    );
  }

  // Step 2: search for image data
  const parts = resultJson.candidates[0].content?.parts || [];
  let base64Image = null;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].inlineData && parts[i].inlineData.data) {
      base64Image = parts[i].inlineData.data;
      break;
    }
  }

  // Step 3: final validation
  if (!base64Image) {
    throw new Error(
      `Candidates returned but no image found.\n${
        JSON.stringify(resultJson, null, 2)}`,
    );
  }

  // 7) Convert base64 back into a Blob and save
  const imgBytes = Utilities.base64Decode(base64Image);
  const blob = Utilities.newBlob(imgBytes, 'image/png', 'nano_banana_result.png');
  const savedFile = projectFolder.createFile(blob);
  Logger.log(`Image saved to Drive: ${savedFile.getUrl()}`);
  return { nanoImageId: savedFile.getId() };
}
