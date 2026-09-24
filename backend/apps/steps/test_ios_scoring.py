"""iOS sessions carry no ML motion labels (no raw sensor stream); only the
'session_mostly_legacy' penalty is skipped for them — every other rule still applies."""
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.steps.anti_cheat import score_session
from apps.steps.models import DeviceRegistration, StepSession, StepSyncEvent

User = get_user_model()


class IosLegacyPenaltyTests(TestCase):
    def _session(self, platform):
        user = User.objects.create_user(
            username=f"walker_{platform}",
            email=f"{platform}@example.com",
            phone_number=f"2547123{'1' if platform == 'ios' else '2'}0000",
            password="testpass123",
        )
        device = DeviceRegistration.objects.create(user=user, device_id=f"dev-{platform}", platform=platform)
        session = StepSession.objects.create(
            user=user,
            device=device,
            session_token_hash=uuid.uuid4().hex,
            server_nonce=uuid.uuid4().hex,
            expires_at=timezone.now() + timedelta(hours=12),
        )
        for i in range(5):
            StepSyncEvent.objects.create(
                user=user,
                session=session,
                device=device,
                client_event_id=f"{platform}-{i}",
                sequence_number=i + 1,
                payload_hash=uuid.uuid4().hex,
                signature_valid=True,
                steps_delta=120,
                accepted=True,
                ml_motion_label=None,
            )
        return session

    @staticmethod
    def _rules(result):
        return {hit.get("rule") for hit in result.get("risk_hits", [])}

    def test_ios_session_without_ml_labels_not_penalised(self):
        result = score_session(self._session("ios"))
        self.assertNotIn("session_mostly_legacy", self._rules(result))

    def test_android_session_without_ml_labels_still_penalised(self):
        result = score_session(self._session("android"))
        self.assertIn("session_mostly_legacy", self._rules(result))
