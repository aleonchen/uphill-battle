#!/usr/bin/env python3
"""开发用静态服务器：禁用缓存，避免浏览器拿到旧版本文件。
用法：python3 serve.py 然后打开 http://localhost:8123
"""
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    http.server.test(
        HandlerClass=NoCacheHandler,
        ServerClass=http.server.ThreadingHTTPServer,
        port=8123,
        bind='',
    )
