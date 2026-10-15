# Bedrock: least-privilege IAM and retention guardrails

Part of [Private AI](private-ai.md), Phase 1. Gives the credentials Darkroom uses only what Analyse needs, and stops anyone in your AWS organization from turning on data retention behind your back.

Replace `111122223333` with your account ID, and the region and model with your own. The examples use the default model in `us-east-1`, the `us.` geographic profile Darkroom picks for that region.

> These examples follow the AWS docs on [inference profile permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html) and [data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html). Check them with the IAM policy simulator, or a test Analyse, before relying on them.

---

## IAM policy for Darkroom

Darkroom calls `InvokeModelWithResponseStream` (streams the edit decision list), `GetAccountDataRetention` (shown in the Analyse confirmation, so it can say "not stored"), and, when `BEDROCK_MODEL_ID` isn't set, `ListInferenceProfiles` (finds the profile for your region's geography) or, with `BEDROCK_IN_REGION=1`, `GetFoundationModel` (checks the model can be called in-region).

A cross-Region profile needs permission on the profile **and** on the underlying model in each region it may route to. The condition limits the second statement to calls made through that profile, so the model can't be invoked directly in another region.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeThroughProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModelWithResponseStream",
      "Resource": "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    },
    {
      "Sid": "ModelBehindProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModelWithResponseStream",
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
      "Condition": {
        "StringEquals": {
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
        }
      }
    },
    {
      "Sid": "ReadRetentionModeAndProfiles",
      "Effect": "Allow",
      "Action": [
        "bedrock:GetAccountDataRetention",
        "bedrock:ListInferenceProfiles",
        "bedrock:GetFoundationModel"
      ],
      "Resource": "*"
    }
  ]
}
```

**In-region model ID** (`BEDROCK_IN_REGION=1`): drop the first statement, and in the second use `arn:aws:bedrock:us-east-1::foundation-model/…` with no condition. Current Claude models (including the default, Sonnet 4.5) can only be called through an inference profile in the regions checked, so Darkroom refuses in-region for them.

The read permissions are optional. Without `GetAccountDataRetention`, the confirmation warns that the retention mode couldn't be checked. Without `ListInferenceProfiles`, Darkroom falls back to the profiles it has confirmed (`us.`, `eu.`, `jp.`, `au.`) and refuses other regions until you set `BEDROCK_MODEL_ID`.

---

## Example SCP: keep data retention at `none`

Set the mode once (Bedrock console → Settings → Data retention, or `aws bedrock put-account-data-retention --mode none` in each region you use). Then attach this service control policy in AWS Organizations so nobody except a named admin role can change it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PinBedrockDataRetention",
      "Effect": "Deny",
      "Action": "bedrock:PutAccountDataRetention",
      "Resource": "*",
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": "arn:aws:iam::*:role/BedrockRetentionAdmin"
        }
      }
    },
    {
      "Sid": "NoGlobalInferenceProfiles",
      "Effect": "Deny",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:*:*:inference-profile/global.*"
    }
  ]
}
```

The second statement is optional. It enforces at the account level what Darkroom already does in code: refusing `global.` profiles, which can route requests to any region worldwide.

With the mode pinned to `none`, models that require retention (Claude Fable 5 / 5.1) fail with a `ValidationException` even if `BEDROCK_ALLOW_RETENTION_MODELS=1` is set. That's the intended safety net.

---

## Invocation logging

Darkroom never turns on Bedrock model invocation logging. If you've turned it on, every prompt (the full transcript) is written to your own CloudWatch Logs or S3 bucket. It stays in your account, but it is stored. Check under Bedrock console → Settings → Model invocation logging.
