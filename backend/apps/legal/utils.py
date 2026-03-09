"""
Converts uploaded DOCX and PDF files to clean HTML for display in the mobile app.

DOCX → HTML: uses mammoth (preserves headings, bold, lists, tables)
PDF  → HTML: extracts text (formatting limited — recommend DOCX for best results)
"""
import mammoth
import logging

logger = logging.getLogger(__name__)


def docx_to_html(file_obj) -> str:
    """
    Convert a DOCX file to clean HTML using mammoth.
    mammoth strips Word's internal styling and produces semantic HTML.

    Returns HTML string or raises ValueError on failure.
    """
    style_map = """
        p[style-name='Heading 1'] => h1:fresh
        p[style-name='Heading 2'] => h2:fresh
        p[style-name='Heading 3'] => h3:fresh
        b                         => strong
        i                         => em
        u                         => u
        strike                    => s
        table                     => table
        tr                        => tr
        td                        => td
        th                        => th
    """
    try:
        result = mammoth.convert_to_html(file_obj, style_map=style_map)
        html   = result.value
        if result.messages:
            logger.info(f'mammoth warnings: {result.messages}')
        return html
    except Exception as e:
        logger.error(f'DOCX conversion failed: {e}')
        raise ValueError(f'Could not parse DOCX file: {e}')


def pdf_to_html(file_obj) -> str:
    """
    Extract text from a PDF and wrap in basic HTML.
    Note: PDF extraction preserves text but NOT formatting.
    For best results, upload DOCX instead of PDF.
    """
    try:
        import PyPDF2
        reader = PyPDF2.PdfReader(file_obj)
        pages  = []
        for page in reader.pages:
            text = page.extract_text() or ''
            # Wrap each paragraph in <p> tags
            paragraphs = [f'<p>{line.strip()}</p>'
                          for line in text.split('\n')
                          if line.strip()]
            pages.append('\n'.join(paragraphs))
        return '\n<hr/>\n'.join(pages)
    except ImportError:
        raise ValueError('PyPDF2 not installed. Run: pip install PyPDF2')
    except Exception as e:
        logger.error(f'PDF extraction failed: {e}')
        raise ValueError(f'Could not parse PDF file: {e}')


def detect_file_type(filename: str) -> str:
    name = filename.lower()
    if name.endswith('.docx'):  return 'docx'
    if name.endswith('.doc'):   return 'doc'
    if name.endswith('.pdf'):   return 'pdf'
    if name.endswith('.html'):  return 'html'
    return 'unknown'


def process_uploaded_file(file_obj, filename: str) -> tuple[str, str]:
    """
    Main entry point. Takes a file object and filename.
    Returns (html_content, file_type).
    Raises ValueError if file type is unsupported or parsing fails.
    """
    file_type = detect_file_type(filename)

    if file_type == 'docx':
        html = docx_to_html(file_obj)
    elif file_type == 'pdf':
        html = pdf_to_html(file_obj)
    elif file_type == 'html':
        html = file_obj.read().decode('utf-8', errors='replace')
    elif file_type == 'doc':
        raise ValueError(
            'Legacy .doc files are not supported. '
            'Please save as .docx in Microsoft Word and re-upload.'
        )
    else:
        raise ValueError(
            f'Unsupported file type: {filename}. '
            'Please upload a .docx, .pdf, or .html file.'
        )

    return html, file_type
