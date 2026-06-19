import json
import hashlib

def compute_payload_hash(payload: dict) -> str:
    hashable_fields = {
        'session_id': payload.get('session_id'),
        'client_event_id': payload.get('client_event_id'),
        'sequence_number': payload.get('sequence_number'),
        'timestamp_client': payload.get('timestamp_client'),
        'steps_delta': payload.get('steps_delta'),
        'steps_total': payload.get('steps_total'),
        'ml_motion_label': payload.get('ml_motion_label'),
        'ml_walk_probability': round(payload.get('ml_walk_probability') or 0, 4),
        'ml_shake_probability': round(payload.get('ml_shake_probability') or 0, 4),
        'ml_model_version': payload.get('ml_model_version'),
    }
    hashable_fields = {k: v for k, v in hashable_fields.items() if v is not None}
    normalized_json = json.dumps(hashable_fields, sort_keys=True, separators=(',', ':'))
    print(f"JSON: {normalized_json}")
    return hashlib.sha256(normalized_json.encode()).hexdigest()

payload1 = {
    'session_id': 'test-session',
    'client_event_id': 'event-1',
    'sequence_number': 1,
    'timestamp_client': '2026-05-02T10:00:00Z',
    'steps_delta': 100,
    'steps_total': 5000,
    'ml_motion_label': 'walk',
    'ml_walk_probability': 0.85,
    'ml_shake_probability': 0.02,
    'ml_model_version': 'v1',
}

payload3 = payload1.copy()
payload3['ml_walk_probability'] = 0.851234

print(f"Hash 1: {compute_payload_hash(payload1)}")
print(f"Hash 4: {compute_payload_hash(payload3)}")
