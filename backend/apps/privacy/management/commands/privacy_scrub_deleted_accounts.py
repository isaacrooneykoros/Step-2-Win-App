"""Re-run the privacy clean-up for accounts deleted before apps.privacy existed.

    python manage.py privacy_scrub_deleted_accounts [--dry-run]

Idempotent. Old usernames are no longer known for those accounts, so staff audit text
and login records can't be matched; everything else in erasure.py is applied.
"""

from django.core.management.base import BaseCommand

from apps.privacy.erasure import deleted_accounts_missing_scrub, scrub_deleted_user


class Command(BaseCommand):
    help = "Remove privacy leftovers (sessions, reset codes, body measurements) of deleted accounts."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        users = list(deleted_accounts_missing_scrub())
        self.stdout.write(f"{len(users)} deleted account(s) with leftovers")
        if opts["dry_run"]:
            return
        for user in users:
            scrub_deleted_user(user)
        self.stdout.write(self.style.SUCCESS("Done."))
