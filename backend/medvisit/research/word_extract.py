"""Convert untrusted Word sources in a bounded process without application credentials."""
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import NamedTemporaryFile
from xml.etree import ElementTree
from zipfile import ZipFile


class WordTreeBuilder(ElementTree.TreeBuilder):
    def doctype(self, name, pubid, system):
        raise ValueError('Word内容包含不支持的实体定义。')


def extract_word(data):
    result = subprocess.run([sys.executable, '-m', 'medvisit.research.word_extract'], input=data,
        capture_output=True, timeout=20, cwd=Path(__file__).resolve().parents[2],
        env={'PATH':os.defpath, 'PYTHONPATH':str(Path(__file__).resolve().parents[2])})
    if result.returncode or len(result.stdout) > 8_000_000:
        raise ValueError('Word原文无法在安全限制内转换，请人工核对。')
    parsed = json.loads(result.stdout)
    if parsed.get('error'):
        raise ValueError(parsed['error'])
    return parsed['text']


def read_word(data):
    if data.startswith(b'PK'):
        sections, total = [], 0
        with ZipFile(BytesIO(data)) as document:
            if len(document.infolist()) > 2000 or 'word/document.xml' not in document.namelist():
                raise ValueError('不是支持的Word文档，或文档部件过多。')
            for filename, label in [('word/document.xml','正文'), ('word/footnotes.xml','脚注'), ('word/endnotes.xml','尾注')]:
                if filename not in document.namelist():
                    continue
                with document.open(filename) as entry:
                    xml = entry.read(8_000_001)
                total += len(xml)
                if total > 8_000_000:
                    raise ValueError('Word内容超过解析限制。')
                root = ElementTree.fromstring(xml, parser=ElementTree.XMLParser(target=WordTreeBuilder()))
                lines = []
                ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
                for paragraph in root.iter(ns+'p'):
                    line = ''.join(node.text or '' if node.tag == ns+'t' else '\t' if node.tag == ns+'tab' else '\n'
                        for node in paragraph.iter() if node.tag in (ns+'t', ns+'tab', ns+'br'))
                    if line.strip():
                        lines.append(line)
                if lines:
                    sections.append(label+'\n'+'\n'.join(lines))
        return '\n\n'.join(sections)
    if not data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
        raise ValueError('不是支持的DOC/DOCX文件。')
    if sys.platform == 'darwin':
        command = ['/usr/bin/textutil','-convert','txt','-stdout','-stdin','-format','doc','-encoding','UTF-8','-noload','-nostore']
        result = subprocess.run(command, input=data, capture_output=True, timeout=12, env={'PATH':os.defpath})
    elif Path('/usr/bin/antiword').is_file():
        # antiword's stdin mode writes to HOME; use a private temporary file with the credential-free environment.
        with NamedTemporaryFile(suffix='.doc') as document:
            document.write(data)
            document.flush()
            result = subprocess.run(['/usr/bin/antiword','-m','UTF-8.txt',document.name],
                capture_output=True, timeout=12, env={'PATH':os.defpath})
    else:
        raise ValueError('当前环境缺少antiword，DOC附件尚未转换；可使用项目Docker镜像或人工补充。')
    if result.returncode or len(result.stdout) > 8_000_000:
        raise ValueError('DOC附件无法转换为可核对正文。')
    return result.stdout.decode('utf-8', errors='replace')


if __name__ == '__main__':
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
        if sys.platform.startswith('linux'):
            resource.setrlimit(resource.RLIMIT_AS, (512*1024**2, 512*1024**2))
        raw = sys.stdin.buffer.read(20_000_001)
        if len(raw) > 20_000_000:
            raise ValueError('Word附件超过20MB。')
        print(json.dumps({'text':read_word(raw)}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error':str(exc) if isinstance(exc, ValueError) else 'Word结构异常或超过安全解析限制。'}, ensure_ascii=False))
