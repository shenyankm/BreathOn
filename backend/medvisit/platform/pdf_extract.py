"""Extract untrusted PDFs in a time-limited child process, without application credentials."""
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys


def extract_pdf(data):
    if not data.startswith(b'%PDF-') or len(data) > 20_000_000:
        raise ValueError('请上传20MB以内的PDF文件。')
    result = subprocess.run([sys.executable, '-m', 'medvisit.platform.pdf_extract'], input=data,
        capture_output=True, timeout=20, cwd=Path(__file__).resolve().parents[2],
        env={'PATH': os.defpath, 'PYTHONPATH': str(Path(__file__).resolve().parents[2])})
    if result.returncode != 0 or len(result.stdout) > 8_000_000:
        raise ValueError('PDF无法安全解析；请检查文件、页数或改用文本录入。')
    parsed = json.loads(result.stdout)
    if 'error' in parsed:
        raise ValueError(parsed['error'])
    return parsed


def read_pdf(data):
    from pypdf import PdfReader, apply_configuration
    with apply_configuration(maximum_declared_stream_length=2_000_000, zlib_maximum_output_length=2_000_000,
                             stream_decoding_work_maximum_length=8_000_000, stream_parsing_work_maximum_count=200_000):
        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted or not 1 <= len(reader.pages) <= 200:
            raise ValueError('只支持未加密、1至200页的PDF。')
        pages, total = [], 0
        for number, page in enumerate(reader.pages, 1):
            contents = page.get_contents()
            if contents and len(contents.get_data()) > 2_000_000:
                raise ValueError('PDF单页内容过大，请拆分后上传。')
            text = page.extract_text() or ''
            if len(text) > 20000:
                raise ValueError('单页文字超过2万字符，请分段录入。')
            total += len(text)
            if total > 1_000_000:
                raise ValueError('PDF正文超过100万字符，请拆分后上传。')
            if text.strip():
                pages.append({'number': number, 'text': text})
        if not pages:
            raise ValueError('未提取到文字；扫描件请先OCR，或按页录入原文。')
        return {'pages': pages, 'page_count': len(reader.pages)}


if __name__ == '__main__':
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
        if sys.platform.startswith('linux'):
            resource.setrlimit(resource.RLIMIT_AS, (512*1024**2, 512*1024**2))
        raw = sys.stdin.buffer.read(20_000_001)
        if len(raw) > 20_000_000:
            raise ValueError('PDF超过20MB上限。')
        print(json.dumps(read_pdf(raw), ensure_ascii=False))
    except ValueError as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'error': 'PDF结构异常或超过安全解析限制。'}, ensure_ascii=False))
