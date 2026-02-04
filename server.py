from http.server import BaseHTTPRequestHandler, HTTPServer
import json, subprocess, tempfile, os

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers['Content-Length'])
        data = json.loads(self.rfile.read(length))

        pdf_uri = data['pdf']
        page = data['page']
        dpi = data.get('dpi', 150)

        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = os.path.join(tmp, 'input.pdf')
            out_path = os.path.join(tmp, 'out.png')

            subprocess.run([
                'gs',
                '-dSAFER',
                '-dBATCH',
                '-dNOPAUSE',
                f'-dFirstPage={page}',
                f'-dLastPage={page}',
                '-sDEVICE=png16m',
                f'-r{dpi}',
                f'-sOutputFile={out_path}',
                pdf_path
            ], check=True)

            with open(out_path, 'rb') as f:
                img = f.read()

        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.end_headers()
        self.wfile.write(img)

HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
