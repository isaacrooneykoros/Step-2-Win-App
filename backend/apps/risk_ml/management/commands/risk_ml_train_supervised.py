from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = ("OFFLINE: train a supervised cheat model on labelled user-days once there are enough labels "
            "(both classes). Time-based evaluation + model card. Refuses and explains otherwise.")

    def add_arguments(self, parser):
        parser.add_argument("--model", choices=["logreg", "gbt"], default="logreg")
        parser.add_argument("--min-labels", type=int, default=200)
        parser.add_argument("--min-per-class", type=int, default=30)
        parser.add_argument("--threshold", type=float, help="payout-hold threshold to evaluate at "
                                                           "(default settings.RISK_ML_HOLD_THRESHOLD)")
        parser.add_argument("--test-fraction", type=float, default=0.3)
        parser.add_argument("--include-synthetic", action="store_true",
                            help="DRY RUN ONLY: include synthetic labels; the artifact can never be activated")
        parser.add_argument("--activate", action="store_true")
        parser.add_argument("--out-dir")

    def handle(self, *args, **o):
        from apps.risk_ml.training import TrainingRefused, train_supervised

        if o["include_synthetic"] and o["activate"]:
            raise CommandError("--include-synthetic models can't be activated")
        try:
            art = train_supervised(min_labels=o["min_labels"], min_per_class=o["min_per_class"],
                                   model_kind=o["model"], threshold=o["threshold"], test_fraction=o["test_fraction"],
                                   include_synthetic=o["include_synthetic"], activate=o["activate"],
                                   out_dir=o["out_dir"])
        except TrainingRefused as exc:
            raise CommandError(f"Refused: {exc}")
        self.stdout.write(art.model_card)
        self.stdout.write(self.style.SUCCESS(f"Stored {art.version}{' (active)' if art.is_active else ''}"))
