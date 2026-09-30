"""
aws_errors.py — turn AWS credential failures into messages a user can act on.

botocore raises a handful of unrelated exception types when credentials are
missing, expired, or revoked, and the Bedrock client wraps some of them. Left
alone they reach the UI as a raw traceback. Matched by class name / error code
so this module doesn't need boto3 installed to import.
"""

# botocore exceptions raised while *resolving* credentials (before any request)
_CREDENTIAL_EXCEPTIONS = {
    "NoCredentialsError",
    "PartialCredentialsError",
    "CredentialRetrievalError",
    "TokenRetrievalError",          # SSO token expired and refresh failed
    "UnauthorizedSSOTokenError",
    "SSOTokenLoadError",            # never logged in with `aws sso login`
}

# ClientError codes AWS returns when the credentials themselves are bad
_CREDENTIAL_ERROR_CODES = {
    "ExpiredToken",
    "ExpiredTokenException",
    "InvalidClientTokenId",
    "UnrecognizedClientException",
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
}


class AWSCredentialsError(RuntimeError):
    """AWS credentials are missing, expired, or rejected — the fix is on the user's side."""


def _is_credential_error(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name in _CREDENTIAL_EXCEPTIONS:
        return True
    if name == "ClientError":
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        return code in _CREDENTIAL_ERROR_CODES
    # Anthropic SDK: Bedrock rejected the API key / signature (a 403 is left alone —
    # that's usually model access not being enabled, not bad credentials), or found none at all
    if name == "AuthenticationError" and type(exc).__module__.startswith("anthropic"):
        return True
    return isinstance(exc, RuntimeError) and "Could not resolve AWS credentials" in str(exc)


def find_credential_error(exc: BaseException) -> BaseException | None:
    """Return the credential error in exc's cause/context chain, if there is one."""
    seen = set()
    while exc is not None and id(exc) not in seen:
        if _is_credential_error(exc):
            return exc
        seen.add(id(exc))
        exc = exc.__cause__ or exc.__context__
    return None


def credentials_message(service: str, exc: BaseException) -> str:
    return (
        f"Couldn't authenticate with AWS for {service} ({type(exc).__name__}: {exc}).\n\n"
        "If you use `aws sso login`, your session has probably expired — log in again and retry. "
        "Otherwise check the access keys or API key in .env (see \"AWS credentials\" in the README)."
    )
