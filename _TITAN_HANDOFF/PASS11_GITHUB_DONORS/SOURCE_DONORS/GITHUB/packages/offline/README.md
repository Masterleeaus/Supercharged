# Titan Zero Offline / MV3 Restart Recovery

Chrome MV3 service workers may terminate between steps. This runtime stores company-scoped operation checkpoints in TitanBusinessDatabase so startup can identify incomplete work without reconstructing authority or automatically replaying effects.

Recovery is deliberately conservative: an incomplete operation becomes `recovery_required`, `requires_explicit_resume` becomes true, and `automatic_effect_replay` remains false. A governed caller must explicitly acknowledge resume with the preserved operation/idempotency identity before execution may continue.

Checkpoint identity, worker identity, model identity and recovery state never grant authority.
