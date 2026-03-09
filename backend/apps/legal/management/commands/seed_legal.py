"""
Run: python manage.py seed_legal

Seeds the database with the two core legal documents as drafts.
Admin must review and publish them from the admin panel.
"""
import os
from django.core.management.base import BaseCommand
from apps.legal.models import LegalDocument


class Command(BaseCommand):
    help = 'Seed initial legal document records (Privacy Policy + Terms)'

    def handle(self, *args, **kwargs):
        docs = [
            {
                'document_type': 'privacy_policy',
                'title':         'Privacy Policy',
                'slug':          'privacy-policy',
                'content_html':  '<h1>Privacy Policy</h1><p>Upload your Privacy Policy document from the admin panel or paste content here.</p>',
            },
            {
                'document_type': 'terms_and_conditions',
                'title':         'Terms and Conditions',
                'slug':          'terms-and-conditions',
                'content_html':  '<h1>Terms and Conditions</h1><p>Upload your Terms and Conditions document from the admin panel or paste content here.</p>',
            },
        ]
        for d in docs:
            obj, created = LegalDocument.objects.get_or_create(
                document_type=d['document_type'],
                defaults=d
            )
            status = 'Created' if created else 'Already exists'
            self.stdout.write(f'{status}: {obj.title}')

        self.stdout.write(self.style.SUCCESS(
            '\nDone. Go to the admin panel → Legal Documents to upload content and publish.'
        ))
