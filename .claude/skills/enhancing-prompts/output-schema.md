# Output Schema: Prompt Enhancement

## Expected Format (JSON)

```json
{
  "original_prompt": "[The user's original prompt text]",
  "score": {
    "clarity": 3,
    "specificity": 2,
    "context": 4,
    "actionability": 3,
    "average": 3.0
  },
  "enhanced": true,
  "enhanced_prompt": "[The improved prompt text]",
  "changes": [
    "Added explicit output format requirement",
    "Clarified scope to current sprint only",
    "Added persona context for target skill"
  ],
  "rationale": "Original prompt lacked specificity on output format and scope boundaries."
}
```

## When No Enhancement Needed (score >= 4)

```json
{
  "original_prompt": "[The user's original prompt text]",
  "score": {
    "clarity": 5,
    "specificity": 4,
    "context": 4,
    "actionability": 5,
    "average": 4.5
  },
  "enhanced": false,
  "enhanced_prompt": "[Same as original]",
  "changes": [],
  "rationale": "Prompt meets quality threshold; no enhancement needed."
}
```

## Constraints

- Score values are integers 1-5
- Average is computed as mean of all four dimensions
- `enhanced` is boolean: true if changes were made, false otherwise
- `changes` array is empty when `enhanced` is false
- `enhanced_prompt` equals `original_prompt` when not enhanced
