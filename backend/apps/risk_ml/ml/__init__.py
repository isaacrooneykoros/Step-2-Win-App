"""
Pure-Python model code shared by the web process and the offline tooling.

Nothing in this package imports Django or NumPy, so it can be evaluated inside the
512 MB Render web process and imported by the offline scikit-learn export scripts.

- ``runtime``: evaluate exported models (isolation forest, gradient-boosted trees,
  logistic regression) from their JSON form.
- ``pytrain``: small pure-Python trainers (isolation forest, logistic regression) and
  metrics, used when scikit-learn is not installed (tests, CI) and for evaluation.
- ``export_sklearn``: turn fitted scikit-learn estimators into the JSON form (imports
  scikit-learn lazily; only used offline).
"""
