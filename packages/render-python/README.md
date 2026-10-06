# @textscript/render-python

Renders the TextScript IR to Python source, with a source map linking every
node to its lines. Environment-agnostic.

Status: scaffold with the indentation helper. The renderer arrives in roadmap
segment S2. Expected output lives in `test/golden/` and must parse as Python.
