from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = ("Evaluate the anomaly scorer on SYNTHETIC scenarios (nothing is written to the database). "
            "Prints the markdown used in apps/risk_ml/EVALUATION.md.")

    def add_arguments(self, parser):
        parser.add_argument("--seed", type=int, default=7)
        parser.add_argument("--honest", type=int, default=30, help="users per honest archetype")
        parser.add_argument("--cheats", type=int, default=6, help="users per cheat archetype")
        parser.add_argument("--trees", type=int, default=100)
        parser.add_argument("--sklearn", action="store_true", help="fit the forest with scikit-learn")

    def handle(self, *args, **o):
        from apps.risk_ml.evaluation import render_markdown, run_synthetic_evaluation

        summary = run_synthetic_evaluation(seed=o["seed"], honest_per_archetype=o["honest"],
                                           cheats_per_archetype=o["cheats"], n_trees=o["trees"],
                                           use_sklearn=o["sklearn"])
        self.stdout.write(render_markdown(summary))
