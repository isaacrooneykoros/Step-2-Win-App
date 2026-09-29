"""Migration 0004 stages the privacy drafts without ever overwriting staff work."""

import importlib

from django.apps import apps
from django.test import TestCase

from .markdown_lite import markdown_to_html
from .models import LegalDocument

seed = importlib.import_module("apps.legal.migrations.0004_seed_privacy_drafts")


class SeedDraftTests(TestCase):
    def setUp(self):
        LegalDocument.objects.all().delete()

    def test_creates_unpublished_drafts_when_missing(self):
        seed.stage_drafts(apps, None)
        pp = LegalDocument.objects.get(document_type="privacy_policy")
        fp = LegalDocument.objects.get(document_type="fair_play_rules")
        for doc in (pp, fp):
            self.assertEqual(doc.status, "draft")
            self.assertEqual(doc.content_html, "")
            self.assertIn("DRAFT", doc.draft_html)
        self.assertEqual(fp.slug, "fair-play-rules")
        self.assertIn("<h2>", pp.draft_html)
        self.assertIn("<table>", pp.draft_html)

    def test_live_content_and_pending_edits_are_never_touched(self):
        live = LegalDocument.objects.create(
            document_type="privacy_policy", title="Privacy Policy", slug="privacy-policy",
            content_html="<p>Live text</p>", draft_html="<p>Admin is editing</p>", status="published", version=4,
        )
        seed.stage_drafts(apps, None)
        live.refresh_from_db()
        self.assertEqual(live.content_html, "<p>Live text</p>")
        self.assertEqual(live.draft_html, "<p>Admin is editing</p>")
        self.assertEqual((live.status, live.version), ("published", 4))

    def test_empty_draft_slot_gets_the_draft_live_stays(self):
        live = LegalDocument.objects.create(
            document_type="privacy_policy", title="Privacy Policy", slug="privacy-policy",
            content_html="<p>Live text</p>", status="published", version=2,
        )
        seed.stage_drafts(apps, None)
        live.refresh_from_db()
        self.assertEqual(live.content_html, "<p>Live text</p>")
        self.assertIn("DRAFT", live.draft_html)
        self.assertEqual(live.status, "published")
        # Running again changes nothing (the slot is no longer empty).
        before = live.draft_html
        seed.stage_drafts(apps, None)
        live.refresh_from_db()
        self.assertEqual(live.draft_html, before)


class MarkdownLiteTests(TestCase):
    def test_escapes_html_and_renders_basics(self):
        out = markdown_to_html("# Title\n\nHello <script>x</script> **bold** [site](https://example.com)\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |")
        self.assertIn("<h1>Title</h1>", out)
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)
        self.assertIn("<strong>bold</strong>", out)
        self.assertIn('<a href="https://example.com">site</a>', out)
        self.assertIn("<ul><li>a</li><li>b</li></ul>", out)
        self.assertIn("<th>A</th>", out)
        self.assertIn("<td>2</td>", out)

    def test_javascript_links_are_not_rendered(self):
        out = markdown_to_html("[x](javascript:alert(1))")
        self.assertNotIn("href", out)
