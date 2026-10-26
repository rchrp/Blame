Synthetic documents for attachment regression tests, with no user data:

- `report.pdf`: two compressed pages, stating revenue of 42 EUR and a Friday deadline (ReportLab).
- `report.docx`: a heading and a paragraph naming Alice as the owner (python-docx).
- `report.xlsx`: Budget and Schedule worksheets containing Travel / 42 and Deadline / Friday (openpyxl).

Tests verify the original bytes remain unchanged, local and remote tool reads,
pagination, sheet selection, and the PDF tool result in a real Cline SDK request
to an offline model endpoint.
