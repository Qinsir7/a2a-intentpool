# Task Payload Examples

> `task_payload.json` is a **demo file**. Replace its contents with your own task schema for production use.
> The protocol accepts any valid JSON dict — there is no hardcoded task taxonomy.

## Example 1: Code Review

```json
{
    "task_type": "CODE_REVIEW",
    "repo_url": "https://github.com/org/repo",
    "branch": "feature/auth",
    "requirements": "Review the authentication module for security flaws and performance bottlenecks."
}
```

## Example 2: API Integration Test

```json
{
    "task_type": "API_INTEGRATION_TEST",
    "endpoint": "https://api.example.com/v2/users",
    "method": "POST",
    "test_payload": { "email": "test@example.com", "role": "agent" },
    "requirements": "Send the test payload and verify the response schema matches the OpenAPI spec."
}
```

## Example 3: Data Analysis

```json
{
    "task_type": "DATA_ANALYSIS",
    "data_source": "ipfs://QmXyz.../sales_2025.csv",
    "requirements": "Compute monthly revenue trends, identify anomalies, and output a JSON summary."
}
```

## Example 4: Content Generation

```json
{
    "task_type": "CONTENT_GENERATION",
    "topic": "Zero-knowledge proofs for AI model verification",
    "format": "markdown",
    "word_count": 2000,
    "requirements": "Write a technical deep-dive suitable for a developer blog."
}
```

## Example 5: Model Inference

```json
{
    "task_type": "MODEL_INFERENCE",
    "model_id": "llama-3-70b",
    "input": "Summarize the key innovations in the Monad blockchain whitepaper.",
    "config": { "temperature": 0.3, "max_tokens": 1024 },
    "requirements": "Return the inference result as a JSON object with 'summary' and 'key_points' fields."
}
```

## Usage

1. Copy any example above into `task_payload.json`
2. Run `python employer_daemon.py`
3. Enter `task_payload.json` when prompted (or your custom filename)
