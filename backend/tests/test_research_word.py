from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zipfile import ZipFile

import pytest

from medvisit.research import archive
from medvisit.research import word_extract
from medvisit.research.word_extract import extract_word
from test_research_archive import URL, TEXT


def docx(xml):
    data = BytesIO()
    with ZipFile(data, 'w') as zipped:
        zipped.writestr('word/document.xml', xml)
    return data.getvalue()


@pytest.mark.parametrize('encoding', ['utf-8', 'utf-16'])
def test_docx_converter_runs_in_child_and_preserves_paragraphs(encoding):
    raw = docx(f'<?xml version="1.0" encoding="{encoding}"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{TEXT}</w:t></w:r></w:p><w:p><w:r><w:t>第二条测试正文</w:t></w:r></w:p></w:body></w:document>'.encode(encoding))
    text = extract_word(raw)
    assert TEXT in text and '\n第二条测试正文' in text


def test_word_rejects_entity_definitions_and_unknown_binary_data():
    with pytest.raises(ValueError):
        extract_word(docx('<!DOCTYPE doc [<!ENTITY x "bad">]><doc>&x;</doc>'))
    with pytest.raises(ValueError):
        extract_word(b'not-a-word-document')


@pytest.mark.parametrize('encoding', ['utf-8', 'utf-16', 'utf-16-le', 'utf-16-be'])
def test_word_rejects_entity_definitions_in_unicode_xml(encoding):
    declaration = 'utf-8' if encoding == 'utf-8' else 'utf-16'
    xml = ('<?xml version="1.0" encoding="' + declaration + '"?>'
        '<!DOCTYPE doc [<!ENTITY x "Expanded entity">]>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:document>')
    with pytest.raises(ValueError, match='实体定义'):
        extract_word(docx(xml.encode(encoding)))


@pytest.mark.parametrize('failed', [False, True])
def test_linux_doc_uses_private_temporary_file_without_credentials_and_cleans_up(monkeypatch, failed):
    raw = bytes.fromhex('d0cf11e0a1b11ae1') + b'public-test-document'
    paths = []
    monkeypatch.setattr(word_extract.sys, 'platform', 'linux')
    monkeypatch.setattr(Path, 'is_file', lambda self: True)
    def run(command, **kwargs):
        assert command[:3] == ['/usr/bin/antiword', '-m', 'UTF-8.txt']
        path = Path(command[3])
        paths.append(path)
        assert path.read_bytes() == raw and path.stat().st_mode & 0o777 == 0o600
        assert set(kwargs['env']) == {'PATH'} and 'input' not in kwargs
        return SimpleNamespace(returncode=int(failed), stdout=TEXT.encode())
    monkeypatch.setattr(word_extract.subprocess, 'run', run)
    if failed:
        with pytest.raises(ValueError, match='DOC附件'):
            word_extract.read_word(raw)
    else:
        assert word_extract.read_word(raw) == TEXT
    assert len(paths) == 1 and not paths[0].exists()


async def test_word_archive_preserves_original_and_marks_reader_format(tmp_path, monkeypatch):
    raw = docx(f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>{TEXT}</w:t></w:r></w:p></w:document>')
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(raw, URL, {'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})))
    metadata, text = await archive.archive_source(tmp_path, URL)
    folder = tmp_path/metadata['id']/metadata['raw_sha256']
    assert metadata['kind'] == 'docx' and (folder/'original.docx').read_bytes() == raw
    assert TEXT in text and '版式与页码以原件为准' in (folder/'reader.html').read_text()
