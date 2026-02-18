// ============================================================
// CONSTANTS  (set these in Script Properties or here directly)
// ============================================================
// const ROOT_PROJECT_FOLDER_ID   = PropertiesService.getScriptProperties().getProperty('ROOT_PROJECT_FOLDER_ID');
const PARENT_FOLDER_ID         = '0AM-am4ZsL-9cUk9PVA'; //PropertiesService.getScriptProperties().getProperty('PARENT_FOLDER_ID');
const GCS_BUCKET_NAME          = PropertiesService.getScriptProperties().getProperty('GCS_BUCKET_NAME');
const GEMINI_API_KEY           = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const PROPOSAL_TEMPLATE_DOC_ID = PropertiesService.getScriptProperties().getProperty('PROPOSAL_TEMPLATE_DOC_ID');
const SAMPLE_PRICING_SHEET_ID  = PropertiesService.getScriptProperties().getProperty('SAMPLE_PRICING_SHEET_ID');
const CLOUD_RUN_RASTER_URL     = PropertiesService.getScriptProperties().getProperty('CLOUD_RUN_RASTER_URL');
const EXCLUDED_NAME            = 'c-';



// Map nenoResp fields to product names (adjust these to match your sheet)
const productMapping = {
  'cameraBoxMarker': 'RapidDeploy 5G Solar Dual Camera PTZ including shipping ',  // Adjust to match exact product name in sheet
  'infillMarkers': 'Tripod RapidDeploy unit for mounting including shipping and fasteners',         // Adjust to match exact product name in sheet
  'setupAndIt': 'Setup and IT deployment (remote), per unit ',
  'nightMonitoring':'Nightly monitorig (6PM - 6AM) 7-days a week including 5G connection '
};



// Email address that receives the completion report.
// Set via Script Properties: key = NOTIFY_EMAIL
const NOTIFY_EMAIL = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL')
                  || Session.getActiveUser().getEmail(); // fallback: script owner


// Gemini model names — change here if Google updates them
const GEMINI_TEXT_MODEL  = 'gemini-3-flash-preview'; // PDF and text processing
const GEMINI_IMAGE_MODEL = 'gemini-3-pro-image-preview';  

// ============================================================
// LOGGING HELPER
// ============================================================
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG;  // Lower this in production

/**
 * Structured logger that prefixes every line with a timestamp + level.
 */
function log(level, message, data) {
  if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;

  const timestamp = new Date().toISOString();
  const prefix    = `[${timestamp}] [${level}]`;
  const line      = data !== undefined
    ? `${prefix} ${message} | ${JSON.stringify(data)}`
    : `${prefix} ${message}`;

  if (level === 'ERROR' || level === 'WARN') {
    Logger.log(line);   // Also captured in Apps Script logs
  }
  console.log(line);
}

// Convenience wrappers
const logDebug = (msg, data) => log('DEBUG', msg, data);
const logInfo  = (msg, data) => log('INFO',  msg, data);
const logWarn  = (msg, data) => log('WARN',  msg, data);
const logError = (msg, data) => log('ERROR', msg, data);

// ============================================================
// STATUS HELPER  (writes to Script Properties so UI can poll)
// ============================================================
function setStatus(message) {
  logInfo(`STATUS → ${message}`);
  PropertiesService.getScriptProperties().setProperty('status', message);
}

// ============================================================
// ENTRY POINT
// ============================================================
/**
 * Main entry point. Scans Drive folders, queues PDFs, then
 * processes each queued item end-to-end.
 */
function start(data) {
 
  logInfo('==== start() BEGIN ====');

  try {
    scanFoldersForPDFs();
  } catch (err) {
    logError('scanFoldersForPDFs failed — aborting', err.toString());
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const queue = getQueuedPDFs();
  console.log(queue)
  logInfo(`Queue loaded. Total items: ${queue.length}`);

  const queued = queue.filter(pdf => pdf.status === 'QUEUED');
  logInfo(`Items with status=QUEUED: ${queued.length}`);

  if (queued.length === 0) {
    logInfo('Nothing to process. Exiting.');
    return;
  }
for (const pdf of queue) {
  if (pdf.status !== 'QUEUED') {
    logDebug(`Skipping non-QUEUED item`, { fileId: pdf.fileId, status: pdf.status });
    continue;
  }

  logInfo(`--- Processing PDF ---`, { fileId: pdf.fileId, fileName: pdf.fileName });

  try {
    processSinglePdf(pdf);
    pdf.status      = 'PROCESSED';
    pdf.processedAt = new Date().toISOString();
    logInfo(`✅ Done`, { fileId: pdf.fileId });
    renameFolderById(pdf)
    // Optional: Add delay between PDFs (in milliseconds)
    Utilities.sleep(5000); // Wait 5 second before next PDF
    
  } catch (err) {
    pdf.status = 'ERROR';
    pdf.error  = err.toString();
    pdf.errorAt = new Date().toISOString();
    logError(`❌ Failed to process PDF`, { fileId: pdf.fileId, error: err.toString() });
     
  }
}

  props.setProperty('PDF_QUEUE', JSON.stringify(queue));
  logInfo('Queue persisted. ==== start() END ====');

  // Always send a completion report, whether items succeeded or failed.
  sendCompletionEmail(queue);
}

/**
 * Processes one PDF through the full pipeline:
 *  1. Create project folder structure
 *  2. Ask Gemini to read the PDF and extract metadata
 *  3. Upload PDF to Cloud Storage
 *  4. Rasterize the site-plan page
 *  5. Annotate the rasterised image via Gemini image model
 *  6. Generate the proposal document
 *  7. Persist artifacts / logs
 *
 * @param {Object} pdf  - Queue entry { fileId, fileName, ... }
 */
function processSinglePdf(pdf) {
  // ── 1. Resolve file & create folder structure ──────────────
  logInfo('Fetching PDF from Drive', { fileId: pdf.fileId });
  const pdfFile = DriveApp.getFileById(pdf.fileId);
 // ROOT_PROJECT_FOLDER_ID
  const root          = DriveApp.getFolderById(pdf.folderId);
  const projectFolder = root.createFolder(`output_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yyyy HH:mm:ss')}`);
  const artifacts     = projectFolder.createFolder('Artifacts');
  const logsFolder    = projectFolder.createFolder('Logs');
  logInfo('Project folder created', { folderId: projectFolder.getId() });

  // Store the folder URL on the queue item so the email can link to it
  pdf.projectFolderUrl = projectFolder.getUrl();
  logInfo('Project folder created', { folderId: projectFolder.getId(), url: pdf.projectFolderUrl });

  // ── 2. Extract metadata via Gemini ─────────────────────────
  setStatus('Sending PDF to Gemini for analysis');
  const geminiResponse = sendPdfToGemini(pdfFile);
  logInfo('Gemini metadata response', geminiResponse);
 

  // ── 3. Upload PDF to GCS ───────────────────────────────────
  setStatus('Uploading PDF to Cloud Storage');
  const gcsUri = uploadPdfToGCS(pdfFile, GCS_BUCKET_NAME);
  logInfo('GCS URI', { gcsUri });

  // ── 4. Rasterise the site-plan page ───────────────────────
  setStatus(`Rasterising page ${geminiResponse.sitePlanPageNumber}`);
  const selectedPages = [{ page: geminiResponse.sitePlanPageNumber }];
  const images        = rasterizeSelectedPages(gcsUri, selectedPages, artifacts);

  if (!images || !images[0] || !images[0].fileId) {
    throw new Error('Rasterisation returned no image');
  }
  logInfo('Page rasterised', { fileId: images[0].fileId });

  // ── 5. Annotate image via Gemini image model ───────────────
  setStatus('Annotating site plan image');
  const nenoResponse = callNanoBanana(projectFolder, images[0].fileId);
  logInfo('Annotation complete', { nanoImageId: nenoResponse.nanoImageId });

  // ── 6. Generate proposal document ─────────────────────────
  setStatus('Generating proposal document');
  generateDocument(projectFolder, nenoResponse, geminiResponse);
  // generateDocument(projectFolder, {nanoImageId: '17vptf46klzZRUtg9IIPa1hMIj7G8OH3p', cameraBoxMarker:3, infillMarkers :6}, {
  //   "totalLinearFootage": 840,
  //   "totalCameraCount": 3,
  //   "sitePlanPageNumber": 8,
  //   "email": "cgarner@pkwycon.com",
  //   "clientName": "AutoZone Corporate",
  //   "companyName": "AutoZone Corporate",
  //   "projectName": "AutoZone Auto Parts Retail Store #10601",
  //   "siteAddress": "W 20th St & S Avenue B, Yuma, Arizona, Usa, 85364"
  // });
 
  logInfo('Document generated');

  // ── 7. Persist additional artifacts ───────────────────────
  persistArtifacts(artifacts, images);
  persistLog(logsFolder, { geminiResponse, gcsUri, imagesCount: images.length });

  setStatus('Complete');
}
 
// ============================================================
// PDF FOLDER SCAN
// ============================================================

/**
 * Scans subfolders of PARENT_FOLDER_ID for PDFs and adds new
 * ones to the queue, skipping folders whose name contains
 * EXCLUDED_NAME and skipping already-queued fileIds.
 */
function scanFoldersForPDFs() {
  logInfo('scanFoldersForPDFs: scanning', { parentFolderId: PARENT_FOLDER_ID });

  const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const subFolders   = parentFolder.getFolders();

  let scanned  = 0;
  let skipped  = 0;
  let newItems = 0;
  const pdfQueue = [];

  while (subFolders.hasNext()) {
    const folder     = subFolders.next();
    const folderName = folder.getName();
    scanned++;

    if (folderName.toLowerCase().includes(EXCLUDED_NAME)) {
      logDebug(`Skipping excluded folder: "${folderName}"`);
      skipped++;
      continue;
    }

    const files = folder.getFilesByType(MimeType.PDF);

    while (files.hasNext()) {
      const file = files.next();
      newItems++;
      pdfQueue.push({
        folderId:  folder.getId(),
        folderName,
        fileId:    file.getId(),
        fileName:  file.getName(),
        fileUrl:   file.getUrl(),
        queuedAt:  new Date().toISOString(),
        status:    'QUEUED',
      });
    }
  }

  logInfo(`scanFoldersForPDFs: complete`, { scanned, skipped, found: newItems });
  savePDFQueue(pdfQueue);
}

/**
 * Merges newly found PDFs into the persisted queue.
 * Deduplicates by fileId.
 *
 * @param {Array} pdfQueue
 */
function savePDFQueue(pdfQueue) {
  logInfo('savePDFQueue', { incoming: pdfQueue.length });

  if (!pdfQueue.length) {
    logInfo('savePDFQueue: nothing to save');
    return;
  }

  const props    = PropertiesService.getScriptProperties();
  const existing = props.getProperty('PDF_QUEUE');
  // let stored     = existing ? JSON.parse(existing) : [];
  let stored     =   [];

  const existingIds = new Set(stored.map(p => p.fileId));
  const fresh       = pdfQueue.filter(p => !existingIds.has(p.fileId));

  stored = stored.concat(fresh);
  props.setProperty('PDF_QUEUE', JSON.stringify(stored));
  logInfo(`savePDFQueue: added ${fresh.length} new item(s); total stored: ${stored.length}`);
}

/**
 * Returns the full queue from Script Properties.
 *
 * @returns {Array}
 */
function getQueuedPDFs() {
  const props = PropertiesService.getScriptProperties();
  const data  = props.getProperty('PDF_QUEUE');
  const queue = data ? JSON.parse(data) : [];
  logDebug(`getQueuedPDFs: ${queue.length} item(s) in queue`);
  return queue;
}


// ============================================================
// GCS UPLOAD
// ============================================================

/**
 * Uploads a Drive PDF file to Google Cloud Storage.
 *
 * @param {DriveApp.File} pdfFile
 * @param {string}        bucketName
 * @returns {string}  Public HTTPS URL of the uploaded object
 */
function uploadPdfToGCS(pdfFile, bucketName) {
  const fileName = cleanPdfFileName(pdfFile.getName());
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(fileName)}`;

  logDebug('uploadPdfToGCS: starting upload', { bucketName, fileName });

  const response = UrlFetchApp.fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${ScriptApp.getOAuthToken()}`,
      'Content-Type': 'application/pdf',
    },
    payload:            pdfFile.getBlob().getBytes(),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(`GCS upload failed (HTTP ${code}): ${response.getContentText()}`);
  }

  const gcsUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
  logInfo('uploadPdfToGCS: upload successful', { gcsUrl });
  return gcsUrl;
}

// ============================================================
// RASTERISATION
// ============================================================

/**
 * Calls the Cloud Run raster service to convert one PDF page
 * to a PNG blob.
 *
 * @param {string} pdfGcsUri
 * @param {number} pageNumber  1-based page number
 * @returns {Blob}
 */
function rasterizePage(pdfGcsUri, pageNumber, maxRetries = 3) {
  logDebug('rasterizePage', { pdfGcsUri, pageNumber });

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logDebug(`Rasterize attempt ${attempt}/${maxRetries}`, { pageNumber });

      const response = UrlFetchApp.fetch(CLOUD_RUN_RASTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ pdf: pdfGcsUri, page: pageNumber }),
        muteHttpExceptions: true,
      });

      const code = response.getResponseCode();
      
      if (code !== 200) {
        throw new Error(`Raster service failed (HTTP ${code}): ${response.getContentText()}`);
      }

      logDebug('rasterizePage: response received', { attempt, statusCode: code, pageNumber });
      return Utilities.newBlob(response.getBlob().getBytes(), 'image/png', `page_${pageNumber}.png`);

    } catch (err) {
      lastError = err;
      logError(`Rasterize attempt ${attempt} failed`, { pageNumber, error: err.toString() });

      if (attempt < maxRetries) {
        const waitTime = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
        logDebug(`Waiting ${waitTime}ms before retry...`, { pageNumber });
        Utilities.sleep(waitTime);
      }
    }
  }

  // All retries exhausted
  throw new Error(
    `Failed to rasterize page ${pageNumber} after ${maxRetries} attempts. ` +
    `Last error: ${lastError.toString()}`
  );
}

/**
 * Rasterises a set of pages and saves each PNG to an Artifacts
 * folder in Drive.
 *
 * @param {string}             pdfUri
 * @param {Array<{page:number}>} pages
 * @param {DriveApp.Folder}    artifactsFolder
 * @returns {Array<{page, blob, fileId, ocrText}>}
 */
function rasterizeSelectedPages(pdfUri, pages, artifactsFolder) {
  logInfo('rasterizeSelectedPages', { pdfUri, pageCount: pages.length });

  return pages.map(p => {
    const blob = rasterizePage(pdfUri, p.page);
    const file = artifactsFolder
      .createFile(blob)
      .setName(`page_${p.page}.png`);

    logDebug('rasterizeSelectedPages: page saved', { page: p.page, fileId: file.getId() });
    return {
      page:    p.page,
      blob,
      fileId:  file.getId(),
      ocrText: p.text || null,
    };
  });
}

// ============================================================
// GEMINI — PDF ANALYSIS
// ============================================================

/**
 * Sends a PDF to Gemini for construction-plan analysis.
 * Returns structured JSON with totalLinearFootage,
 * totalCameraCount, sitePlanPageNumber, and client details.
 *
 * @param {DriveApp.File} pdfFile
 * @returns {Object}
 */
function sendPdfToGemini(pdfFile) {
  logInfo('sendPdfToGemini: uploading PDF to Gemini');
  const geminiFileName = uploadPdfToGemini(pdfFile);
  setStatus('PDF uploaded — requesting analysis from Gemini');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
// PROMPT
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
  projectName
  siteAddress
`.trim();

  const payload = {
    contents: [{
      role:  'user',
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

  logDebug('sendPdfToGemini: sending request');
  const res = UrlFetchApp.fetch(url, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error(`Gemini analysis request failed (HTTP ${code}): ${res.getContentText()}`);
  }

  const result = extractGeminiJson(JSON.parse(res.getContentText()));
  logInfo('sendPdfToGemini: result', result);
  return result;
}

/**
 * Safely extracts and parses the JSON payload from a Gemini
 * generateContent response.
 *
 * @param {Object} response  - Parsed Gemini API response
 * @returns {Object}
 */
function extractGeminiJson(response) {
  setStatus('Parsing Gemini response');
  logDebug('extractGeminiJson: raw response', response);

  const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini returned no text. Full response: ${JSON.stringify(response)}`);
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    // Fallback: extract first JSON block from the text
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Gemini response is not valid JSON: ${text}`);
    }
    logWarn('extractGeminiJson: used fallback JSON extraction');
    return JSON.parse(match[0]);
  }
}

// ============================================================
// GEMINI — FILE UPLOAD
// ============================================================

/**
 * Initiates a resumable upload session for a PDF to the Gemini
 * Files API and uploads the bytes.
 *
 * @param {DriveApp.File} pdfFile
 * @returns {string}  The Gemini file resource name (e.g. "files/abc123")
 */function uploadPdfToGemini(pdfFile, maxRetries = 3) {
  logInfo('uploadPdfToGemini: creating upload session');
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logDebug(`Upload attempt ${attempt}/${maxRetries}`);
      
      const uploadUri = createGeminiUploadSession(pdfFile);
      const bytes = pdfFile.getBlob().getBytes();

      setStatus(`Uploading PDF bytes to Gemini (attempt ${attempt}/${maxRetries})`);

      const res = UrlFetchApp.fetch(uploadUri, {
        method:  'PUT',
        headers: {
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        payload: bytes,
        muteHttpExceptions: true,
      });

      const code = res.getResponseCode();
      const text = res.getContentText();

      logDebug('uploadPdfToGemini: upload response', { attempt, code, body: text });

      if (code !== 200) {
        throw new Error(`Gemini PDF upload failed (HTTP ${code}): ${text}`);
      }

      const json = JSON.parse(text);
      if (!json?.file?.name) {
        throw new Error(`Unexpected Gemini upload response (missing file.name): ${text}`);
      }

      logInfo('uploadPdfToGemini: success', { attempt, fileName: json.file.name });
      return json.file.name;
      
    } catch (err) {
      lastError = err;
      logError(`Upload attempt ${attempt} failed`, { error: err.toString() });
      
      if (attempt < maxRetries) {
        const waitTime = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
        logDebug(`Waiting ${waitTime}ms before retry...`);
        Utilities.sleep(waitTime);
      }
    }
  }
  
  // All retries exhausted
  throw new Error(`Failed to upload PDF after ${maxRetries} attempts. Last error: ${lastError.toString()}`);
}

/**
 * Creates a resumable upload session via the Gemini Files API.
 *
 * @param {DriveApp.File} pdfFile
 * @returns {string}  The upload URL
 */
function createGeminiUploadSession(pdfFile) {
  const bytes    = pdfFile.getBlob().getBytes();
  const fileSize = bytes.length;

  logDebug('createGeminiUploadSession', { displayName: pdfFile.getName(), fileSize });

  const res = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
    {
      method:  'post',
      headers: {
        'X-Goog-Upload-Protocol':             'resumable',
        'X-Goog-Upload-Command':              'start',
        'X-Goog-Upload-Header-Content-Type':  'application/pdf',
        'X-Goog-Upload-Header-Content-Length': String(fileSize),
        'Content-Type':                        'application/json',
      },
      payload: JSON.stringify({
        file: { displayName: cleanPdfFileName(pdfFile.getName()) },
      }),
      muteHttpExceptions: true,
    },
  );

  const uploadUrl = res.getHeaders()['X-Goog-Upload-URL']
                 || res.getHeaders()['x-goog-upload-url'];

  if (!uploadUrl) {
    logError('createGeminiUploadSession: no upload URL', { body: res.getContentText() });
    throw new Error('Gemini did not return an upload URL');
  }

  logDebug('createGeminiUploadSession: session created', { uploadUrl });
  return uploadUrl;
}

// ============================================================
// GEMINI — IMAGE ANNOTATION (NanoBanana)
// ============================================================

/**
 * Sends a rasterised site-plan image to the Gemini image model
 * for annotation, saves the result to Drive, and returns its
 * fileId.
 *
 * @param {DriveApp.Folder} projectFolder
 * @param {string}          fileId  - Drive fileId of the source PNG
 * @returns {{ nanoImageId: string }}
 */
function callNanoBanana(projectFolder, fileId, maxRetries = 10) {
  logInfo('callNanoBanana: starting', { fileId });
// PROMPT NANO BANANA
  const promptText = `
Annotate the construction perimeter for temporary fencing and camera coverage.

ANNOTATION INSTRUCTIONS:
1. PERIMETER LINE
   - Trace the dashed "LIMIT OF DISTURBANCE" (LOD) boundary with a solid red line (6 px thickness).
   - Ensure the red line precisely follows the dashed LOD line on the plan.
   - Maintain line clarity over lighter background elements.

2. CAMERA BOX MARKERS
   - Add red square markers (~16 px) at:
     - NW corner (likely pedestrian access gate near parking/street)
     - NE corner (eastern property line intersection)
     - SE corner (service driveway or staging zone)
     - SW corner (main entrance/driveway)
     - Any visible gates, driveways, or utility pads

3. INFILL MARKERS
   - Place additional red camera markers every ~350 linear feet along the LOD path.
   - Measure spacing along the boundary line, not straight-line distances.
   - Ensure visual balance and full coverage of the perimeter.

4. STYLE
   - Offset each marker ~10 px outward from the perimeter to avoid overlap.
   - Do not place markers over text, scale bar, or north arrow.
   - Do not apply decorative shadows or glows — keep clean and professional.

OUTPUT:
- Final image must show the complete red perimeter line.
- All camera markers must be clearly visible and evenly spaced.
- Must be suitable for direct inclusion in a professional client proposal.
`.trim();

  const file = DriveApp.getFileById(fileId);
  const sourceBlob = file.getBlob();
  const encodedImage = Utilities.base64Encode(sourceBlob.getBytes());

  const payload = {
    contents: [{
      parts: [
        {
          inline_data: {
            mime_type: sourceBlob.getContentType(),
            data: encodedImage,
          },
        },
        { text: promptText },
      ],
    }],
    generationConfig: {
      responseModalities: ["IMAGE"],
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  let lastError;
  let lastResultJson;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logDebug('callNanoBanana: sending to Gemini image model', { attempt, maxRetries });
      
      const response = UrlFetchApp.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        },
      );

      const code = response.getResponseCode();
      const resultJson = JSON.parse(response.getContentText());
      lastResultJson = resultJson;
      
      logDebug('callNanoBanana: response', { attempt, code, candidates: resultJson.candidates?.length });

      if (code !== 200) {
        throw new Error(`Gemini image model failed (HTTP ${code}): ${JSON.stringify(resultJson)}`);
      }

      if (!resultJson.candidates?.length) {
        throw new Error(`Gemini returned no candidates.\n${JSON.stringify(resultJson, null, 2)}`);
      }

      const candidate = resultJson.candidates[0];
      
      // Check for empty content or OTHER finish reason
      if (candidate.finishReason === 'OTHER' || !candidate.content || Object.keys(candidate.content).length === 0) {
        throw new Error(`Gemini refused to generate image (finishReason: ${candidate.finishReason})`);
      }

      const parts = candidate.content?.parts || [];
      let base64Image = null;

      for (const part of parts) {
        if (part.inlineData?.data) {
          base64Image = part.inlineData.data;
          break;
        }
      }

      if (!base64Image) {
        throw new Error(`Gemini returned candidates but no image data.`);
      }

      // Success! Save the image
      const imgBytes = Utilities.base64Decode(base64Image);
      const blob = Utilities.newBlob(imgBytes, 'image/png', 'annotated_site_plan.png');
      const savedFile = projectFolder.createFile(blob);
      
      persistLog(projectFolder, { 
        fileId: savedFile.getId(), 
        url: savedFile.getUrl(), 
        attempts: attempt,
        nenoResponseJson: JSON.stringify(resultJson, null, 2) 
      });
      
      logInfo('callNanoBanana: annotated image saved', { 
        fileId: savedFile.getId(), 
        url: savedFile.getUrl(),
        attempts: attempt
      });
      
      return { nanoImageId: savedFile.getId() };

    } catch (err) {
      lastError = err;
      logError(`callNanoBanana attempt ${attempt} failed`, { error: err.toString() });

      if (attempt < maxRetries) {
        const waitTime = 2000 * attempt; // Linear backoff: 2s, 4s, 6s, 8s, 10s
        logDebug(`Waiting ${waitTime}ms before retry...`);
        Utilities.sleep(waitTime);
      }
    }
  }

  // All retries exhausted
  const errorDetails = lastResultJson 
    ? `\nLast response: ${JSON.stringify(lastResultJson, null, 2)}`
    : '';
  
  throw new Error(
    `Failed to generate image after ${maxRetries} attempts. ` +
    `Last error: ${lastError.toString()}${errorDetails}`
  );
}



function extractJSON(text) {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) throw new Error("No JSON block found");

  return JSON.parse(match[1]);
}

// ============================================================
// DOCUMENT GENERATION
// ============================================================

/**
 * Copies the proposal template, fills in placeholders, inserts
 * a pricing table, and embeds the annotated site-plan image.
 *
 * @param {DriveApp.Folder} folderLocation
 * @param {{ nanoImageId: string, cameraBoxMarker: number, infillMarkers: number }} nenoResp
 * @param {Object} geminiResponse
 *
 * /**
 * Helper function to get the discount percentage based on quantity slabs
 *//**
 * Configuration object for adjustable pricing parameters
 *//**
 * Configuration object for adjustable pricing parameters
 *//**
 * ═══════════════════════════════════════════════════════════
 * PRICING CONFIGURATION - Edit this to customize pricing
 * ═══════════════════════════════════════════════════════════
 */
const PRICING_CONFIG = {
  // Monthly service rates
  monthlyServices: {
    liveVideoSurveillancePerCamera: 500.00,
    patrolAndResponsePerWeekly: 1200.00
  },
  
  // Contract terms
  contractTermMonths: 12,
  patrolQuantity: 1
};

/**
 * Helper function to get the discount percentage based on quantity slabs
 */
function getDiscountForQuantity(quantity, slabs) {
  // slabs format: { "1-5": 0, "5-10": 10, "10-20": 15, "20-1000": 20 }
  for (const [range, discount] of Object.entries(slabs)) {
    const [min, max] = range.split('-').map(Number);
    if (quantity >= min && quantity <= max) {
      return discount;
    }
  }
  return 0;
}

/**
 * Read pricing data from Google Sheet and build product catalog
 */
function buildPricingCatalog() {
  const sheet = SpreadsheetApp.openById(SAMPLE_PRICING_SHEET_ID).getSheetByName('Sheet1');
  const data = sheet.getDataRange().getDisplayValues();
  
  // Expected format:
  // Row 0: Product | Unit price | 1-5 | 5-10 | 10-20 | 20-1000
  // Row 1+: Camera Box Marker | 100 | 0 | 10 | 15 | 20
  
  const catalog = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const productName = row[0];
    const unitPrice = parseFloat(row[1]) || 0;
    
    // Build slabs object from remaining columns
    const slabs = {};
    for (let j = 2; j < row.length && j <= 6; j++) {
      const header = data[0][j]; // Get slab range from header (e.g., "1-5")
      const discountValue = parseFloat(row[j]) || 0;
      if (header) {
        slabs[header] = discountValue;
      }
    }
    
    catalog.push({
      productName: productName,
      unitPrice: unitPrice,
      slabs: slabs
    });
  }
  
  logInfo('buildPricingCatalog: loaded products', { count: catalog.length });
  return catalog;
}

/**
 * Calculate line item with discount
 */
function calculateLineItem(product, quantity) {
  const unitPrice = product.unitPrice;
  const discountPercent = getDiscountForQuantity(quantity, product.slabs);
  const discountedPrice = unitPrice * (1 - discountPercent / 100);
  const total = discountedPrice * quantity;
  
  return {
    description: product.productName,
    quantity: quantity,
    unitCost: discountedPrice,
    total: total,
    discount: discountPercent,
    originalUnitPrice: unitPrice
  };
}

/**
 * Populate pricing table (one-time costs) - reads all products from sheet
 */
function populatePricingTable(targetTable, totalCameraCount) {
  logInfo('populatePricingTable: start', { totalCameraCount });
  
  // Build pricing catalog from sheet
  const pricingCatalog = buildPricingCatalog();
  
  // Calculate line items for ALL products using same quantity
  const lineItems = [];
  for (const product of pricingCatalog) {
    const lineItem = calculateLineItem(product, totalCameraCount);
    lineItems.push(lineItem);
  }
  
  logInfo('populatePricingTable: calculated line items', { count: lineItems.length });
  
  // Remove existing data rows (keep header)
  const startRowIndex = 1;
  while (targetTable.getNumRows() > startRowIndex) {
    targetTable.removeRow(startRowIndex);
  }
  
  // Insert pricing data rows
  let oneTimeTotal = 0;
  
  for (const item of lineItems) {
    const newRow = targetTable.appendTableRow();
    
    // Description
    newRow.appendTableCell(item.description);
    
    // Quantity
    const qtyCell = newRow.appendTableCell(String(item.quantity));
    qtyCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
    
    // Unit Cost (with discount applied)
    const unitCostText = '$' + item.unitCost.toLocaleString('en-US', { 
      minimumFractionDigits: 2, 
      maximumFractionDigits: 2 
    });
    const unitCostCell = newRow.appendTableCell(unitCostText);
    unitCostCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
    
    // Total
    const totalText = '$' + item.total.toLocaleString('en-US', { 
      minimumFractionDigits: 2, 
      maximumFractionDigits: 2 
    });
    const totalCell = newRow.appendTableCell(totalText);
    totalCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
    
    oneTimeTotal += item.total;
    
    // Log discount info
    if (item.discount > 0) {
      logDebug(`Applied ${item.discount}% discount to ${item.description}`);
    }
  }
  
  // Add "One-Time Total" row
  const totalRow = targetTable.appendTableRow();
  totalRow.appendTableCell('One-Time Total').getChild(0).asParagraph().setBold(true);
  totalRow.appendTableCell(''); // Empty Quantity
  totalRow.appendTableCell(''); // Empty Unit Cost
  
  const totalCell = totalRow.appendTableCell('$' + oneTimeTotal.toLocaleString('en-US', { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  }));
  totalCell.getChild(0).asParagraph().setBold(true).setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  logInfo('populatePricingTable: completed', { rows: lineItems.length, total: oneTimeTotal });
  
  return oneTimeTotal;
}

/**
 * Populate monthly service cost table
 */
function populateMonthlyServiceTable(targetTable, cameraCount, config = PRICING_CONFIG) {
  logInfo('populateMonthlyServiceTable: start', { cameraCount });
  
  // Remove existing data rows (keep header)
  const startRowIndex = 1;
  while (targetTable.getNumRows() > startRowIndex) {
    targetTable.removeRow(startRowIndex);
  }
  
  let monthlyTotal = 0;
  
  // Row 1: Live Video Surveillance Per Camera
  const cameraRow = targetTable.appendTableRow();
  cameraRow.appendTableCell('Nightly monitorig (6PM - 6AM) 7-days a week including 5G connection ');
  
  const cameraQtyCell = cameraRow.appendTableCell(String(cameraCount));
  cameraQtyCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  const cameraRateText = '$' + config.monthlyServices.liveVideoSurveillancePerCamera.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const cameraRateCell = cameraRow.appendTableCell(cameraRateText);
  cameraRateCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  const cameraMonthlyTotal = cameraCount * config.monthlyServices.liveVideoSurveillancePerCamera;
  const cameraMonthlyText = '$' + cameraMonthlyTotal.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const cameraMonthlyCell = cameraRow.appendTableCell(cameraMonthlyText);
  cameraMonthlyCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  monthlyTotal += cameraMonthlyTotal;
  
  // Row 2: Patrol and Response Per Weekly Patrols
  // const patrolRow = targetTable.appendTableRow();
  // patrolRow.appendTableCell('Patrol and Response Per Weekly Patrols');
  
  // const patrolQtyCell = patrolRow.appendTableCell(String(config.patrolQuantity));
  // patrolQtyCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  // const patrolRateText = '$' + config.monthlyServices.patrolAndResponsePerWeekly.toLocaleString('en-US', {
  //   minimumFractionDigits: 2,
  //   maximumFractionDigits: 2
  // });
  // const patrolRateCell = patrolRow.appendTableCell(patrolRateText);
  // patrolRateCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  // const patrolMonthlyTotal = config.patrolQuantity * config.monthlyServices.patrolAndResponsePerWeekly;
  // const patrolMonthlyText = '$' + patrolMonthlyTotal.toLocaleString('en-US', {
  //   minimumFractionDigits: 2,
  //   maximumFractionDigits: 2
  // });
  // const patrolMonthlyCell = patrolRow.appendTableCell(patrolMonthlyText);
  // patrolMonthlyCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  // monthlyTotal += patrolMonthlyTotal;
  
  // Row 3: Monthly Recurring Total
  const totalRow = targetTable.appendTableRow();
  const totalLabelCell = totalRow.appendTableCell('Monthly Recurring Total');
  totalLabelCell.getChild(0).asParagraph().setBold(true);
  totalRow.appendTableCell(''); // Empty Quantity
  totalRow.appendTableCell(''); // Empty Rate
  
  const totalText = '$' + monthlyTotal.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const totalCell = totalRow.appendTableCell(totalText);
  totalCell.getChild(0).asParagraph().setBold(true).setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  logInfo('populateMonthlyServiceTable: completed', { monthlyTotal });
  
  return monthlyTotal;
}

/**
 * Populate estimate and term table
 */
function populateEstimateAndTermTable(targetTable, oneTimeTotal, monthlyTotal, config = PRICING_CONFIG) {
  logInfo('populateEstimateAndTermTable: start', { oneTimeTotal, monthlyTotal });
  
  // Remove existing data rows (keep header)
  const startRowIndex = 1;
  while (targetTable.getNumRows() > startRowIndex) {
    targetTable.removeRow(startRowIndex);
  }
  
  // Row 1: One-Time Start Up Cost
  const oneTimeRow = targetTable.appendTableRow();
  oneTimeRow.appendTableCell('One-Time Start Up Cost');
  const oneTimeText = '$' + oneTimeTotal.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const oneTimeCell = oneTimeRow.appendTableCell(oneTimeText);
  oneTimeCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  // Row 2: Monthly Services x [term]
  const monthlyServicesTotal = monthlyTotal * config.contractTermMonths;
  const monthlyRow = targetTable.appendTableRow();
  monthlyRow.appendTableCell('Monthly Services x ' + config.contractTermMonths);
  const monthlyText = '$' + monthlyServicesTotal.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const monthlyCell = monthlyRow.appendTableCell(monthlyText);
  monthlyCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  // Row 3: Estimated Project Total
  const projectTotal = oneTimeTotal + monthlyServicesTotal;
  const totalRow = targetTable.appendTableRow();
  const totalLabelCell = totalRow.appendTableCell('Estimated Project Total');
  totalLabelCell.getChild(0).asParagraph().setBold(true);
  
  const totalText = '$' + projectTotal.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const totalCell = totalRow.appendTableCell(totalText);
  totalCell.getChild(0).asParagraph().setBold(true).setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  
  logInfo('populateEstimateAndTermTable: completed', { projectTotal });
  
  return projectTotal;
}

/**
 * Helper function to remove placeholder text from a table
 */
function removeTablePlaceholder(table, placeholder) {
  const numRows = table.getNumRows();
  for (let r = 0; r < numRows; r++) {
    const row = table.getRow(r);
    const numCells = row.getNumCells();
    for (let c = 0; c < numCells; c++) {
      const cell = row.getCell(c);
      const cellText = cell.getText();
      if (cellText.includes(placeholder)) {
        cell.clear();
      }
    }
  }
}

/**
 * Main document generation function
 */
function generateDocument(folderLocation, nenoResp, geminiResponse, customConfig = {}) {
  logInfo('generateDocument: start', { folderId: folderLocation.getId() });
  
  // Merge custom config with defaults
  const config = { ...PRICING_CONFIG, ...customConfig };
  
  // ── Copy template ──────────────────────────────────────────
  const templateFile = DriveApp.getFileById(PROPOSAL_TEMPLATE_DOC_ID);
  const destinationFolder = DriveApp.getFolderById(folderLocation.getId());
  const copiedFile = templateFile.makeCopy('Generated Proposal Document', destinationFolder);
  logInfo('generateDocument: template copied', { copiedFileId: copiedFile.getId() });
  
  // ── Open with retry (Drive copy can take a moment) ─────────
  let doc = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      doc = DocumentApp.openById(copiedFile.getId());
      break;
    } catch (e) {
      logWarn(`generateDocument: open attempt ${attempt}/5 failed — retrying in 1.5 s`);
      Utilities.sleep(1500);
    }
  }
  
  if (!doc) throw new Error('Failed to open copied proposal document after 5 attempts');
  
  const body = doc.getBody();
  
  // ── Find all tables ────────────────────────────────────────
  let pricingTable = null;
  let monthlyServiceTable = null;
  let estimateTermTable = null;
  
  const numChildren = body.getNumChildren();
  
  for (let i = 0; i < numChildren; i++) {
    const child = body.getChild(i);
    
    if (child.getType() === DocumentApp.ElementType.TABLE) {
      const table = child.asTable();
      const tableText = table.getText();
      
      if (tableText.includes('{{PRICING_TABLE}}')) {
        pricingTable = table;
        logInfo('generateDocument: found PRICING_TABLE at index ' + i);
        removeTablePlaceholder(table, '{{PRICING_TABLE}}');
      }
      else if (tableText.includes('{{MONTHLY_SERVICE_COST}}')) {
        monthlyServiceTable = table;
        logInfo('generateDocument: found MONTHLY_SERVICE_COST at index ' + i);
        removeTablePlaceholder(table, '{{MONTHLY_SERVICE_COST}}');
      }
      else if (tableText.includes('{{ESTIMATE_AND_TERM}}')) {
        estimateTermTable = table;
        logInfo('generateDocument: found ESTIMATE_AND_TERM at index ' + i);
        removeTablePlaceholder(table, '{{ESTIMATE_AND_TERM}}');
      }
    }
  }
  
  let oneTimeTotal = 0;
  let monthlyTotal = 0;
  
  const totalCameraCount = geminiResponse.totalCameraCount || 0;
  
  // ── Populate pricing table (one-time costs) ────────────────
  if (pricingTable) {
    logInfo('generateDocument: populating pricing table');
    oneTimeTotal = populatePricingTable(pricingTable, totalCameraCount);
  } else {
    logWarn('generateDocument: PRICING_TABLE not found');
  }
  
  // ── Populate monthly service table ─────────────────────────
  if (monthlyServiceTable) {
    logInfo('generateDocument: populating monthly service table');
    monthlyTotal = populateMonthlyServiceTable(monthlyServiceTable, totalCameraCount, config);
  } else {
    logWarn('generateDocument: MONTHLY_SERVICE_COST table not found');
  }
  
  // ── Populate estimate and term table ───────────────────────
  if (estimateTermTable) {
    logInfo('generateDocument: populating estimate and term table');
    populateEstimateAndTermTable(estimateTermTable, oneTimeTotal, monthlyTotal, config);
  } else {
    logWarn('generateDocument: ESTIMATE_AND_TERM table not found');
  }
  
  // ── Text replacements ──────────────────────────────────────
  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yyyy');
  const replacements = {
    '{{DATE}}': dateStr,
    '{{email}}': geminiResponse.email || '',
    '{{CLIENT_NAME}}': geminiResponse.clientName || '',
    '{{COMPANY_NAME}}': geminiResponse.companyName || '',
    '{{PROJECT_NAME}}': geminiResponse.projectName || '',
    '{{SITE_ADDRESS}}': geminiResponse.siteAddress || '',
    '{{LINEAR_FOOTAGE}}': String(geminiResponse.totalLinearFootage || ''),
    '{{CAMERA_COUNT}}': String(geminiResponse.totalCameraCount || ''),
  };
  
  for (const [placeholder, value] of Object.entries(replacements)) {
    body.replaceText(placeholder, value);
  }
  
  logDebug('generateDocument: text replacements done');
  
  // ── Embedded image ─────────────────────────────────────────
  insertImageAtPlaceholder(body, '{{CAMERA_IMAGE}}', nenoResp.nanoImageId);
  logInfo('generateDocument: image inserted');
  
  doc.saveAndClose();
  logInfo('generateDocument: document saved and closed');
}

/**
 * Insert image at placeholder with proper sizing
 */
function insertImageAtPlaceholder(body, placeholder, imageFileId) {
  logDebug('insertImageAtPlaceholder', { placeholder, imageFileId });

  const imageBlob = DriveApp.getFileById(imageFileId).getBlob();
  const found     = body.findText(placeholder);

  if (!found) {
    throw new Error(`Image placeholder not found: ${placeholder}`);
  }

  const element   = found.getElement();
  const parent    = element.getParent();
  const text      = element.asText();

  text.deleteText(found.getStartOffset(), found.getEndOffsetInclusive());

  let insertedImage = null;

  if (parent.getType() === DocumentApp.ElementType.PARAGRAPH) {
    insertedImage = parent.asParagraph().insertInlineImage(0, imageBlob);
  } else {
    insertedImage = parent.getParent().insertInlineImage(
      parent.getParent().getChildIndex(parent) + 1,
      imageBlob,
    );
  }

  // ── Resize image to fit page width ──────────────────────────
  if (insertedImage) {
    const pageWidth = 612;           // 8.5 inches in points
    const leftMargin = 72;           // 1 inch
    const rightMargin = 72;          // 1 inch
    const maxWidth = pageWidth - leftMargin - rightMargin;

    const originalWidth = insertedImage.getWidth();
    const originalHeight = insertedImage.getHeight();

    if (originalWidth > maxWidth) {
      const aspectRatio = originalHeight / originalWidth;
      const newWidth = maxWidth;
      const newHeight = newWidth * aspectRatio;

      insertedImage.setWidth(newWidth);
      insertedImage.setHeight(newHeight);

      logDebug('insertImageAtPlaceholder: resized', {
        originalWidth,
        originalHeight,
        newWidth,
        newHeight
      });
    }
  }
}


// ============================================================
// ARTIFACT PERSISTENCE
// ============================================================

/**
 * Saves a simple "ok" JSON marker per processed image.
 *
 * @param {DriveApp.Folder}            folder
 * @param {Array<{page:number, blob}>} images
 */
function persistArtifacts(folder, images) {
  images.forEach(img => {
    folder.createFile(
      `page_${img.page}_gemini.json`,
      JSON.stringify({ status: 'ok', page: img.page }, null, 2),
      MimeType.PLAIN_TEXT,
    );
  });
  logInfo('persistArtifacts: done', { count: images.length });
}

/**
 * Writes a JSON run-log to the Logs folder.
 *
 * @param {DriveApp.Folder} logsFolder
 * @param {Object}          data
 */
function persistLog(logsFolder, data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  logsFolder.createFile(
    `run_log_${timestamp}.json`,
    JSON.stringify(data, null, 2),
    MimeType.PLAIN_TEXT,
  );
  logInfo('persistLog: run log written');
}

// ============================================================
// UTILITIES
// ============================================================

/**
 * Sanitises a PDF filename for use as a GCS/Gemini object name.
 * Keeps only alphanumerics, spaces, underscores, and hyphens.
 *
 * @param {string} fileName
 * @returns {string}
 */
function cleanPdfFileName(fileName) {
  const ext = fileName.toLowerCase().endsWith('.pdf') ? '.pdf' : '';
  let name  = ext ? fileName.slice(0, -4) : fileName;

  name = name.replace(/[^a-zA-Z0-9 _-]/g, '');  // strip special chars
  name = name.replace(/\s+/g, '_');               // spaces → underscores
  name = name.replace(/[_-]{2,}/g, '_');          // collapse repeated separators
  name = name.replace(/^[_-]+|[_-]+$/g, '');      // trim leading/trailing separators

  return (name || 'file') + ext;
} 
// ============================================================
// COMPLETION EMAIL
// ============================================================

/**
 * Sends a styled HTML summary email to NOTIFY_EMAIL once all
 * queue items have been processed.
 *
 * The email includes:
 *  - Overall run stats (total / processed / failed)
 *  - A per-file results table with status, timestamps, Drive
 *    folder links, and error messages where applicable
 *  - A plain-text fallback for email clients that block HTML
 *
 * @param {Array} queue  - The full queue array after processing
 */
function sendCompletionEmail(queue) {
  // ── Tally results ──────────────────────────────────────────
  const processed = queue.filter(p => p.status === 'PROCESSED');
  const failed    = queue.filter(p => p.status === 'ERROR');
  const skipped   = queue.filter(p => p.status !== 'PROCESSED' && p.status !== 'ERROR');

  const total     = queue.length;
  const allOk     = failed.length === 0;
  const runDate   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM dd, yyyy – HH:mm z');

  const subject   = allOk
    ? `✅ Proposal Pipeline Complete — ${processed.length}/${total} succeeded (${runDate})`
    : `⚠️ Proposal Pipeline Done — ${failed.length} error(s) of ${total} (${runDate})`;

  logInfo('sendCompletionEmail: composing', {
    to: NOTIFY_EMAIL, total, processed: processed.length, failed: failed.length,
  });

  // ── Build email bodies ─────────────────────────────────────
  const htmlBody  = buildEmailHtml(queue, processed, failed, skipped, runDate);
  const plainBody = buildEmailPlain(queue, processed, failed, runDate);

  // ── Send ───────────────────────────────────────────────────
  try {
    GmailApp.sendEmail(NOTIFY_EMAIL, subject, plainBody, {
      htmlBody,
      name: 'Proposal Pipeline',
      noReply: true,
    });
    logInfo('sendCompletionEmail: sent successfully', { to: NOTIFY_EMAIL, subject });
  } catch (err) {
    // Email failure must never crash the main pipeline
    logError('sendCompletionEmail: failed to send email', err.toString());
  }
}

/**
 * Builds the HTML body for the completion email.
 *
 * @param {Array}  queue
 * @param {Array}  processed
 * @param {Array}  failed
 * @param {Array}  skipped
 * @param {string} runDate
 * @returns {string}  HTML string
 */
function buildEmailHtml(queue, processed, failed, skipped, runDate) {
  const total  = queue.length;
  const allOk  = failed.length === 0;

  // ── Colour tokens ──────────────────────────────────────────
  const ACCENT   = allOk ? '#1a7f4b' : '#c0392b';   // green or red header bar
  const TAG_OK   = 'background:#d4edda;color:#155724;';
  const TAG_ERR  = 'background:#f8d7da;color:#721c24;';
  const TAG_SKIP = 'background:#fff3cd;color:#856404;';

  // ── Status badge helper ────────────────────────────────────
  function badge(status) {
    const style = status === 'PROCESSED' ? TAG_OK
                : status === 'ERROR'     ? TAG_ERR
                : TAG_SKIP;
    return `<span style="${style}padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">${status}</span>`;
  }

  // ── Per-file table rows ────────────────────────────────────
  const rows = queue.map((pdf, i) => {
    const folderLink = pdf.projectFolderUrl
      ? `<a href="${pdf.projectFolderUrl}" style="color:#1a6fc4;">Open folder</a>`
      : '—';

    const timestamp = pdf.processedAt || pdf.errorAt || pdf.queuedAt || '—';

    const errorCell = pdf.status === 'ERROR'
      ? `<td style="padding:8px 12px;color:#721c24;font-size:12px;font-family:monospace;word-break:break-word;max-width:260px;">${escapeHtml(pdf.error || '')}</td>`
      : `<td style="padding:8px 12px;color:#aaa;">—</td>`;

    const rowBg = i % 2 === 0 ? '#ffffff' : '#f9f9f9';

    return `
      <tr style="background:${rowBg};vertical-align:top;">
        <td style="padding:8px 12px;font-size:13px;">${escapeHtml(pdf.fileName || pdf.fileId)}</td>
        <td style="padding:8px 12px;">${badge(pdf.status)}</td>
        <td style="padding:8px 12px;font-size:12px;color:#555;">${escapeHtml(timestamp)}</td>
        <td style="padding:8px 12px;font-size:12px;">${folderLink}</td>
        ${errorCell}
      </tr>`;
  }).join('');

  // ── Stat cards ─────────────────────────────────────────────
  function card(label, value, bg, fg) {
    return `
      <td style="width:33%;text-align:center;padding:16px;background:${bg};border-radius:8px;">
        <div style="font-size:32px;font-weight:700;color:${fg};">${value}</div>
        <div style="font-size:13px;color:#555;margin-top:4px;">${label}</div>
      </td>`;
  }

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);">

        <!-- Header bar -->
        <tr>
          <td style="background:${ACCENT};padding:24px 32px;">
            <p style="margin:0;font-size:22px;font-weight:700;color:#fff;">
              ${allOk ? '✅' : '⚠️'} Proposal Pipeline Report
            </p>
            <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.8);">${runDate}</p>
          </td>
        </tr>

        <!-- Stat cards -->
        <tr>
          <td style="padding:24px 32px;">
            <table width="100%" cellpadding="8" cellspacing="8">
              <tr>
                ${card('Total PDFs', total,              '#f0f2f5', '#333')}
                ${card('Processed',  processed.length,   '#d4edda', '#155724')}
                ${card('Failed',     failed.length,      failed.length ? '#f8d7da' : '#f0f2f5', failed.length ? '#721c24' : '#aaa')}
              </tr>
            </table>
          </td>
        </tr>

        <!-- Results table -->
        <tr>
          <td style="padding:0 32px 32px;">
            <p style="font-size:15px;font-weight:600;color:#333;margin:0 0 12px;">File Results</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;font-size:13px;">
              <thead>
                <tr style="background:#f5f5f5;">
                  <th style="padding:10px 12px;text-align:left;color:#555;font-weight:600;border-bottom:1px solid #e0e0e0;">File</th>
                  <th style="padding:10px 12px;text-align:left;color:#555;font-weight:600;border-bottom:1px solid #e0e0e0;">Status</th>
                  <th style="padding:10px 12px;text-align:left;color:#555;font-weight:600;border-bottom:1px solid #e0e0e0;">Timestamp</th>
                  <th style="padding:10px 12px;text-align:left;color:#555;font-weight:600;border-bottom:1px solid #e0e0e0;">Folder</th>
                  <th style="padding:10px 12px;text-align:left;color:#555;font-weight:600;border-bottom:1px solid #e0e0e0;">Error</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f5f5f5;padding:16px 32px;border-top:1px solid #e0e0e0;">
            <p style="margin:0;font-size:12px;color:#999;">
              Sent automatically by the Proposal Pipeline · Google Apps Script
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>

</body>
</html>`;
}

/**
 * Builds the plain-text fallback body for the completion email.
 *
 * @param {Array}  queue
 * @param {Array}  processed
 * @param {Array}  failed
 * @param {string} runDate
 * @returns {string}
 */
function buildEmailPlain(queue, processed, failed, runDate) {
  const lines = [
    `Proposal Pipeline Report — ${runDate}`,
    '='.repeat(50),
    `Total : ${queue.length}`,
    `OK    : ${processed.length}`,
    `Failed: ${failed.length}`,
    '',
    'FILE RESULTS',
    '-'.repeat(50),
  ];

  queue.forEach(pdf => {
    lines.push(`[${pdf.status}] ${pdf.fileName || pdf.fileId}`);
    if (pdf.processedAt) lines.push(`  Processed : ${pdf.processedAt}`);
    if (pdf.errorAt)     lines.push(`  Failed at : ${pdf.errorAt}`);
    if (pdf.error)       lines.push(`  Error     : ${pdf.error}`);
    if (pdf.projectFolderUrl) lines.push(`  Folder    : ${pdf.projectFolderUrl}`);
    lines.push('');
  });

  lines.push('-'.repeat(50));
  lines.push('Sent automatically by the Proposal Pipeline.');
  return lines.join('\n');
}

/**
 * Escapes special HTML characters to prevent XSS in the email body.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// UTILITIES
// ============================================================

/**
 * Sanitises a PDF filename for use as a GCS/Gemini object name.
 * Keeps only alphanumerics, spaces, underscores, and hyphens.
 *
 * @param {string} fileName
 * @returns {string}
 */
function cleanPdfFileName(fileName) {
  const ext = fileName.toLowerCase().endsWith('.pdf') ? '.pdf' : '';
  let name  = ext ? fileName.slice(0, -4) : fileName;

  name = name.replace(/[^a-zA-Z0-9 _-]/g, '');  // strip special chars
  name = name.replace(/\s+/g, '_');               // spaces → underscores
  name = name.replace(/[_-]{2,}/g, '_');          // collapse repeated separators
  name = name.replace(/^[_-]+|[_-]+$/g, '');      // trim leading/trailing separators

  return (name || 'file') + ext;
}

function renameFolderById(pdf) {
  var folderId = pdf.folderId; // Replace with actual folder ID

  var folder = DriveApp.getFolderById(folderId);
  var newName = EXCLUDED_NAME + folder.getName();
  folder.setName(newName);

  Logger.log("Folder renamed to: " + folder.getName());
}
