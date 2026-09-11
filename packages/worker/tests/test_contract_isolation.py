import pytest

from config import validate_provider_environment


def test_non_ark_provider_requires_contract_mode():
    with pytest.raises(ValueError, match="CONTRACT_PROVIDER_MODE_REQUIRED"):
        validate_provider_environment(
            test_mode=False,
            provider_base_url="http://127.0.0.1:19091/api/v3",
            provider_key="",
        )


def test_contract_provider_rejects_real_provider_key():
    with pytest.raises(ValueError, match="REAL_PROVIDER_CREDENTIAL_FORBIDDEN"):
        validate_provider_environment(
            test_mode=True,
            provider_base_url="http://127.0.0.1:19091/api/v3",
            provider_key="ark-real-looking-key",
        )


def test_contract_provider_must_be_loopback():
    with pytest.raises(ValueError, match="CONTRACT_PROVIDER_REQUIRED"):
        validate_provider_environment(
            test_mode=True,
            provider_base_url="https://example.com/api/v3",
            provider_key="",
        )
