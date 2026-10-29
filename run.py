#!/usr/bin/env python3
"""
Simple local development server for PHF Converter.
Serves static assets with the correct MIME type for WebAssembly (application/wasm)
and automatically opens the browser.
"""

import http.server
import socketserver
import webbrowser
import os
import sys

PORT = 8080

class PHFHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable Cross-Origin Isolation for high-resolution timers if needed
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def guess_type(self, path):
        if path.endswith('.wasm'):
            return 'application/wasm'
        if path.endswith('.phf'):
            return 'application/octet-stream'
        return super().guess_type(path)

def run():
    web_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(web_dir)
    
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), PHFHandler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"\n========================================================")
        print(f"  PHF Converter Server running at: {url}")
        print(f"  Web root: {web_dir}")
        print(f"  Press Ctrl+C to stop the server.")
        print(f"========================================================\n")
        
        try:
            webbrowser.open(url)
        except Exception:
            pass
            
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == '__main__':
    run()
