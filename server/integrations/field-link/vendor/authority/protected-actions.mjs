const PROTECTED_EFFECTS=new Set(['write','submit','purchase','payment','delete','publish','send','approve','sign','book','cancel','reschedule']);
const PROTECTED_CLASSES=new Set([
  'money_movement','refund','payment_change','external_communication','record_deletion',
  'permission_change','access_change','security_change','irreversible_action',
  'safety_high_risk','environmental_high_risk','external_commitment','approval','signature'
]);

export function isProtectedAction(input={}){
  if(input.protected_action!=null)return Boolean(input.protected_action);
  return PROTECTED_EFFECTS.has(String(input.effect??'').trim())||PROTECTED_CLASSES.has(String(input.action_class??'').trim());
}
