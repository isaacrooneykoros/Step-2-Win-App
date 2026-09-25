from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "List risk-model artifacts, or activate / deactivate one by version."

    def add_arguments(self, parser):
        parser.add_argument("--activate", metavar="VERSION")
        parser.add_argument("--deactivate", metavar="VERSION")

    def handle(self, *args, **o):
        from apps.risk_ml.models import ModelArtifact
        from apps.risk_ml.training import TrainingRefused, activate_version

        if o["activate"]:
            try:
                art = activate_version(o["activate"])
            except (ModelArtifact.DoesNotExist, TrainingRefused) as exc:
                raise CommandError(str(exc))
            self.stdout.write(self.style.SUCCESS(f"Activated {art.version}"))
        if o["deactivate"]:
            n = ModelArtifact.objects.filter(version=o["deactivate"]).update(is_active=False)
            self.stdout.write(f"Deactivated {n} artifact(s)")
        for a in ModelArtifact.objects.defer("payload").order_by("-created_at")[:50]:
            self.stdout.write(f"{'*' if a.is_active else ' '} {a.version:45} {a.kind:10} {a.trained_on:9} "
                              f"{a.created_at:%Y-%m-%d %H:%M}")
