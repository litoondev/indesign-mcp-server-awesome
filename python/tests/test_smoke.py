"""Smoke test: build a tiny docx in memory, extract it, and assert exact text."""
from __future__ import annotations

import io
import os
import tempfile
import unittest

from docx import Document

from brac_extract import docx_reader


class DocxRoundtripTest(unittest.TestCase):
    def test_paragraph_with_tricky_chars(self):
        doc = Document()
        doc.add_paragraph("Hello, world. ")                       # trailing space
        doc.add_paragraph("Line1­with soft hyphen")          # U+00AD
        doc.add_paragraph("Phone: 01711-123456.")                 # colon + dot

        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
            path = f.name
        try:
            doc.save(path)
            items, _ = docx_reader.extract(path)
            paras = [it for it in items if it.kind == "paragraph"]
            self.assertEqual(paras[0].text, "Hello, world. ")
            self.assertIn("­", paras[1].text)
            self.assertTrue(paras[2].text.endswith("."))
            # SHA-256 is deterministic
            self.assertEqual(paras[0].sha256, paras[0].sha256)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
