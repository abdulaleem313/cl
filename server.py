from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import subprocess
import tempfile
import os
import urllib.request

PORT = int(os.environ.get("PORT", "8080"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Cloud Run health check
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length == 0:
                raise ValueError("Empty request body")

            data = json.loads(self.rfile.read(length))

            pdf_url = data["pdf"]          # HTTPS GCS URL (signed or public)
            page = int(data["page"])       # 1-based page number
            dpi = int(data.get("dpi", 150))

            with tempfile.TemporaryDirectory() as tmp:
                pdf_path = os.path.join(tmp, "input.pdf")
                out_path = os.path.join(tmp, "out.png")

                # Download PDF from GCS
                urllib.request.urlretrieve(pdf_url, pdf_path)

                # Convert PDF page → PNG
                subprocess.run(
                    [
                        "gs",
                        "-dSAFER",
                        "-dBATCH",
                        "-dNOPAUSE",
                        f"-dFirstPage={page}",
                        f"-dLastPage={page}",
                        "-sDEVICE=png16m",
                        f"-r{dpi}",
                        f"-sOutputFile={out_path}",
                        pdf_path,
                    ],
                    check=True,
                )

                with open(out_path, "rb") as f:
                    img = f.read()

            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(img)))
            self.end_headers()
            self.wfile.write(img)

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(str(e).encode("utf-8"))


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
