from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = ("OFFLINE: train the isolation-forest anomaly model on the feature store and store it as a "
            "ModelArtifact (inactive unless --activate). Uses scikit-learn if installed, else pure Python.")

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=90, help="training window (days back from today)")
        parser.add_argument("--trees", type=int, default=100)
        parser.add_argument("--max-samples", type=int, default=256)
        parser.add_argument("--seed", type=int, default=0)
        parser.add_argument("--min-rows", type=int, default=500)
        parser.add_argument("--pure-python", action="store_true", help="don't use scikit-learn even if installed")
        parser.add_argument("--activate", action="store_true", help="make it the model the nightly job uses")
        parser.add_argument("--out-dir", help="also write <version>.json and the model card here")

    def handle(self, *args, **o):
        from apps.risk_ml.training import TrainingRefused, train_anomaly

        try:
            art = train_anomaly(days=o["days"], n_trees=o["trees"], max_samples=o["max_samples"], seed=o["seed"],
                                use_sklearn=False if o["pure_python"] else None, min_rows=o["min_rows"],
                                activate=o["activate"], out_dir=o["out_dir"])
        except TrainingRefused as exc:
            raise CommandError(f"Refused: {exc}")
        self.stdout.write(art.model_card)
        self.stdout.write(self.style.SUCCESS(f"Stored {art.version}{' (active)' if art.is_active else ''}"))
