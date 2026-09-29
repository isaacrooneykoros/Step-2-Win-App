"""
Stage the new Privacy Policy and Fair Play Rules drafts (backend/legal/*.md) for review.

Safe by construction:
- never publishes anything and never touches live content (content_html, status,
  version): the text lands in ``draft_html``, which staff review and publish from
  Admin > Legal documents;
- a missing document is created as an unpublished draft;
- an existing document only gets the draft when its draft slot is EMPTY, so pending
  edits by an admin are never overwritten;
- runs once (a migration); re-running the file by hand changes nothing already staged.
The texts carry a "DRAFT: have a Kenyan data-protection lawyer review" notice that must be
removed before publishing.
"""

from pathlib import Path

from django.db import migrations

LEGAL_DIR = Path(__file__).resolve().parents[3] / "legal"

DOCS = (
    ("privacy_policy", "Privacy Policy", "privacy-policy", "PRIVACY_POLICY.md"),
    ("fair_play_rules", "Fair Play and Payout Review Rules", "fair-play-rules", "TERMS_ADDENDUM_ANTICHEAT.md"),
)
SUMMARY = "Draft staged from backend/legal (needs legal review before publishing)"


def stage_drafts(apps, schema_editor):
    from apps.legal.markdown_lite import markdown_to_html

    LegalDocument = apps.get_model("legal", "LegalDocument")
    for doc_type, title, slug, filename in DOCS:
        path = LEGAL_DIR / filename
        if not path.exists():
            continue
        html = markdown_to_html(path.read_text(encoding="utf-8"))
        doc = LegalDocument.objects.filter(document_type=doc_type).first()
        if doc is None:
            if LegalDocument.objects.filter(slug=slug).exists():
                continue  # slug used by another document: leave it to staff
            LegalDocument.objects.create(
                document_type=doc_type,
                title=title,
                slug=slug,
                content_html="",
                draft_html=html,
                file_type="html",
                version=1,
                version_label="1.1",
                status="draft",
                change_summary=SUMMARY,
            )
        elif not (doc.draft_html or "").strip():
            doc.draft_html = html
            doc.save(update_fields=["draft_html", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("legal", "0003_fair_play_rules_type"),
    ]

    operations = [
        migrations.RunPython(stage_drafts, migrations.RunPython.noop),
    ]
