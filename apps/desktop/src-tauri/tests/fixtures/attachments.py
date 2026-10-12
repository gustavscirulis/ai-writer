"""Writes a solid red PNG, a one-page PDF and a CSV, each with a known answer, into argv[1]."""

import struct
import sys
import zlib
from pathlib import Path

out = Path(sys.argv[1])


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


size = 64
rows = b"".join(b"\x00" + b"\xff\x00\x00" * size for _ in range(size))
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(rows))
    + chunk(b"IEND", b"")
)
(out / "swatch.png").write_bytes(png)

stream = b"BT /F1 24 Tf 72 720 Td (The launch codename is PINEAPPLE-42.) Tj ET"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
pdf = b"%PDF-1.4\n"
offsets = []
for number, body in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += b"%d 0 obj\n%s\nendobj\n" % (number, body)
xref = len(pdf)
pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
pdf += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
(out / "brief.pdf").write_bytes(pdf)

(out / "fruit.csv").write_text("fruit,count\nMANGO,17\n")
