# Classifier example

Uses a Noul question to estimate whether a change needs an additional review.
The workflow returns the classifier model, probability, and usage.

Run from the repository root with a compatible classifier endpoint:

```sh
seqlane run workflows/classifier-example/workflow.ts \
  --input '{"change":"example change"}' \
  --classifier-url https://classifier.example/v1/classify \
  --classifier-model model-id
```

Input is `{ change: string }`; output contains one `needsReview` probability
from 0 to 1. Set `SEQLANE_CLASSIFIER_API_KEY` for the remote endpoint. A
classifier task does not need an agent adapter. The workflow does not choose a
review threshold; its consumer decides how to use the probability.
