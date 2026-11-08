/** Desk-to-Titan Workforce adapter roles, not an additional execution engine.
 * GitHub services/workforce remains the only authoritative runtime owner.
 */
export const CATALOG_VERSION = 'titan.workforce.desk-catalog.v1';
export const WORKFLOWS = Object.freeze({
  reception: Object.freeze({owner:'desk', resource:'conversation', outcome:'draft_response', review:'human'}),
  sales: Object.freeze({owner:'desk', resource:'lead', outcome:'qualify_lead', review:'human'}),
  quote: Object.freeze({owner:'field', resource:'estimate', outcome:'review_quote', review:'human'}),
  booking: Object.freeze({owner:'field', resource:'booking_request', outcome:'review_booking', review:'human'}),
  scheduling: Object.freeze({owner:'field', resource:'visit', outcome:'review_schedule', review:'human'}),
  dispatch: Object.freeze({owner:'field', resource:'work_order', outcome:'review_dispatch', review:'human'}),
  jobs: Object.freeze({owner:'field', resource:'job', outcome:'review_job', review:'human'}),
  invoicing: Object.freeze({owner:'field', resource:'invoice', outcome:'review_invoice', review:'human'}),
  'customer-care': Object.freeze({owner:'desk', resource:'conversation', outcome:'draft_response', review:'human'}),
  rebooking: Object.freeze({owner:'field', resource:'visit', outcome:'review_rebooking', review:'human'}),
});
export function lookupWorkflow(name){
  return typeof name==='string'&&Object.hasOwn(WORKFLOWS,name)?WORKFLOWS[name]:null;
}
