const required=(value,code)=>{const text=String(value??"").trim();if(!text)throw new Error(code);return text;};
const parse=row=>row?{...row,provenance:JSON.parse(row.provenance),payload:JSON.parse(row.payload)}:null;

/** Append-only company-scoped adapter over the canonical SQLite evidence table. */
export class SqliteBusinessEvidenceStore {
  constructor(storage){if(!storage||typeof storage.query!=="function")throw new Error("business-evidence-storage-required");this.storage=storage;}

  async append(entry){
    const company_id=required(entry?.company_id,"business-evidence-company-id-required");
    const evidence_id=required(entry?.evidence_id,"business-evidence-id-required");
    if(entry.classification!=="factual"||entry.acceptance_state!=="accepted")throw new Error("business-evidence-factual-accepted-required");
    if(entry.supersedes_evidence_id){
      const parent=await this.get(company_id,entry.supersedes_evidence_id);
      if(!parent)throw new Error("business-evidence-supersession-parent-missing");
      if(parent.subject_type!==entry.subject_type||parent.subject_id!==entry.subject_id)throw new Error("business-evidence-supersession-subject-mismatch");
    }
    await this.storage.query(
      `INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload,created_at,
       evidence_version,classification,acceptance_state,event_type,source_type,source_id,actor_id,agent_id,correlation_id,causation_id,
       decision_id,authority_decision_id,execution_id,verification_id,projection_version,supersedes_evidence_id,occurred_at,accepted_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [evidence_id,company_id,entry.subject_type,entry.subject_id,entry.event_type,JSON.stringify(entry.provenance),JSON.stringify(entry.payload),entry.accepted_at,
       entry.evidence_version,entry.classification,entry.acceptance_state,entry.event_type,entry.source_type,entry.source_id,entry.actor_id??null,entry.agent_id??null,
       entry.correlation_id,entry.causation_id??null,entry.decision_id??null,entry.authority_decision_id??null,entry.execution_id??null,entry.verification_id??null,
       entry.projection_version,entry.supersedes_evidence_id??null,entry.occurred_at,entry.accepted_at],
    );
    return this.get(company_id,evidence_id);
  }

  async get(company_id,evidence_id){
    const result=await this.storage.query(`SELECT * FROM evidence WHERE company_id=$1 AND id=$2 LIMIT 1`,[required(company_id,"business-evidence-company-id-required"),required(evidence_id,"business-evidence-id-required")]);
    return parse(result.rows[0]);
  }

  async acceptedForSubject(company_id,subject_type,subject_id){
    const result=await this.storage.query(
      `SELECT * FROM evidence WHERE company_id=$1 AND subject_type=$2 AND subject_id=$3 AND classification='factual' AND acceptance_state='accepted'
       ORDER BY accepted_at ASC,id ASC`,
      [required(company_id,"business-evidence-company-id-required"),required(subject_type,"business-evidence-subject-type-required"),required(subject_id,"business-evidence-subject-id-required")],
    );
    return result.rows.map(parse);
  }
}
