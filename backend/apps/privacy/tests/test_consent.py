"""Consent: required at registration, versions and re-consent, withdrawal."""

from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.privacy import consent as consent_mod
from apps.privacy.models import Consent, PrivacySettings

from .helpers import PASSWORD, User, make_user, publish

REGISTER = "/api/auth/register/"
CONSENTS = "/api/privacy/consents/"


def registration(username="otieno", phone="254722000201", consents=None):
    body = {
        "username": username,
        "email": f"{username}@example.com",
        "phone_number": phone,
        "password": PASSWORD,
        "confirm_password": PASSWORD,
    }
    if consents is not None:
        body["consents"] = consents
    return body


class RegistrationConsentTests(APITestCase):
    def setUp(self):
        cache.clear()
        publish("terms_and_conditions", 2)
        publish("privacy_policy", 4)

    def test_registration_refused_without_consents_when_switch_is_on(self):
        s = PrivacySettings.load()
        s.require_consent_at_registration = True
        s.save()
        res = self.client.post(REGISTER, registration(), format="json")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["code"], "consent_required")
        self.assertFalse(User.objects.filter(username="otieno").exists())

    def test_registration_refused_when_a_required_box_is_false_or_not_boolean(self):
        for consents in ({"terms": True, "health_data": False}, {"terms": "yes", "health_data": True},
                         {"terms": True}):
            cache.clear()
            res = self.client.post(REGISTER, registration(consents=consents), format="json")
            self.assertEqual(res.status_code, 400, consents)
        self.assertFalse(User.objects.filter(username="otieno").exists())

    def test_registration_records_consents_with_policy_versions(self):
        res = self.client.post(
            REGISTER,
            registration(consents={"terms": True, "health_data": True, "location_walks": False}),
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.data)
        user = User.objects.get(username="otieno")
        rows = {c.purpose: c for c in Consent.objects.filter(user=user)}
        self.assertEqual(set(rows), {"terms", "health_data", "location_walks"})
        self.assertTrue(rows["terms"].granted)
        self.assertEqual(rows["terms"].document_versions, {"terms": 2, "privacy": 4})
        self.assertEqual(rows["terms"].version, "terms=2;privacy=4")
        self.assertEqual(rows["health_data"].document_versions, {"privacy": 4})
        self.assertFalse(rows["location_walks"].granted)
        self.assertEqual(rows["terms"].source, "registration")
        self.assertEqual(consent_mod.missing_required(user), [])

    def test_old_app_without_consents_can_register_while_switch_is_off_by_default(self):
        self.assertFalse(PrivacySettings.load().require_consent_at_registration)
        res = self.client.post(REGISTER, registration(), format="json")
        self.assertEqual(res.status_code, 201, res.data)

    def test_switch_on_refuses_old_apps_that_send_no_consents(self):
        s = PrivacySettings.load()
        s.require_consent_at_registration = True
        s.save()
        res = self.client.post(REGISTER, registration(), format="json")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(User.objects.filter(username="otieno").exists())

    def test_current_clients_are_checked_even_with_the_switch_off(self):
        self.assertFalse(PrivacySettings.load().require_consent_at_registration)
        res = self.client.post(REGISTER, registration(consents={"terms": True, "health_data": False}), format="json")
        self.assertEqual(res.status_code, 400)

    def test_switch_allows_old_clients(self):
        s = PrivacySettings.load()
        s.require_consent_at_registration = False
        s.save()
        res = self.client.post(REGISTER, registration(), format="json")
        self.assertEqual(res.status_code, 201)
        user = User.objects.get(username="otieno")
        self.assertEqual(sorted(consent_mod.missing_required(user)), ["health_data", "terms"])


class ConsentApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        publish("terms_and_conditions", 1)
        publish("privacy_policy", 1)
        self.user = make_user()
        self.client.force_authenticate(self.user)

    def grant_required(self):
        return self.client.post(CONSENTS, {"consents": {"terms": True, "health_data": True},
                                           "source": "reconsent"}, format="json")

    def test_existing_user_without_records_needs_consent(self):
        res = self.client.get(CONSENTS)
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.data["needs_consent"])
        self.assertEqual(sorted(res.data["missing"]), ["health_data", "terms"])
        statuses = {p["purpose"]: p["status"] for p in res.data["purposes"]}
        self.assertEqual(statuses["location_walks"], "not_given")

    def test_grant_then_no_gate(self):
        res = self.grant_required()
        self.assertEqual(res.status_code, 200, res.data)
        self.assertFalse(res.data["needs_consent"])
        self.assertEqual(Consent.objects.filter(user=self.user).count(), 2)
        # Granting again with nothing new writes no extra rows.
        self.grant_required()
        self.assertEqual(Consent.objects.filter(user=self.user).count(), 2)

    def test_required_consent_cannot_be_withdrawn_in_app(self):
        self.grant_required()
        res = self.client.post(CONSENTS, {"consents": {"health_data": False}}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["code"], "required_consent")
        self.assertTrue(consent_mod.has_consent(self.user, "health_data"))

    def test_optional_location_consent_grant_and_withdraw(self):
        self.grant_required()
        res = self.client.post(CONSENTS, {"consents": {"location_walks": True}, "source": "walk_start"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(consent_mod.has_consent(self.user, "location_walks"))
        self.assertEqual(Consent.objects.filter(user=self.user, purpose="location_walks").first().source, "walk_start")
        res = self.client.post(CONSENTS, {"consents": {"location_walks": False}}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertFalse(consent_mod.has_consent(self.user, "location_walks"))
        status = {p["purpose"]: p["status"] for p in res.data["purposes"]}["location_walks"]
        self.assertEqual(status, "withdrawn")
        # The ledger keeps both decisions.
        self.assertEqual(
            list(Consent.objects.filter(user=self.user, purpose="location_walks").order_by("id")
                 .values_list("granted", flat=True)),
            [True, False],
        )

    def test_unknown_purpose_and_bad_values(self):
        for body in ({"consents": {"marketing": True}}, {"consents": {"location_walks": "true"}}, {"consents": {}}, {}):
            res = self.client.post(CONSENTS, body, format="json")
            self.assertEqual(res.status_code, 400, body)

    def test_material_policy_change_asks_again(self):
        self.grant_required()
        self.client.post(CONSENTS, {"consents": {"location_walks": True}}, format="json")
        # A minor update (notify off) doesn't.
        publish("privacy_policy", 2, notify=False)
        self.assertFalse(self.client.get(CONSENTS).data["needs_consent"])
        # A material one (notify on) does: the minimum version rises automatically.
        publish("privacy_policy", 3, notify=True)
        self.assertEqual(PrivacySettings.load().min_privacy_version, 3)
        data = self.client.get(CONSENTS).data
        self.assertTrue(data["needs_consent"])
        self.assertEqual(sorted(data["missing"]), ["health_data", "terms"])
        statuses = {p["purpose"]: p["status"] for p in data["purposes"]}
        self.assertEqual(statuses["location_walks"], "outdated")
        self.assertFalse(consent_mod.has_consent(self.user, "location_walks"))
        # Accepting again records the new version and clears the gate.
        self.grant_required()
        data = self.client.get(CONSENTS).data
        self.assertFalse(data["needs_consent"])
        self.assertEqual(
            Consent.objects.filter(user=self.user, purpose="terms").first().document_versions,
            {"terms": 1, "privacy": 3},
        )

    def test_terms_change_only_affects_terms(self):
        self.grant_required()
        publish("terms_and_conditions", 5, notify=True)
        data = self.client.get(CONSENTS).data
        self.assertEqual(data["missing"], ["terms"])

    def test_minimum_never_above_published_version(self):
        self.grant_required()
        s = PrivacySettings.load()
        s.min_privacy_version = 99  # typo by staff
        s.save()
        self.assertFalse(self.client.get(CONSENTS).data["needs_consent"])

    def test_requires_authentication(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(CONSENTS).status_code, 401)
