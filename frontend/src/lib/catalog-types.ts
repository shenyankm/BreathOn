export type Kind = 'content' | 'doctor' | 'rubric' | 'scenario'
export type Entity = { id: string; version: number; status: string; created_at: string; updated_at: string; created_by: string }
export type Content = Entity & { asset_id?: string | null; usable?:boolean; title: string; version_label: string; scope: string; source_url: string; publication_date: string | null; expires_at: string | null; pages: { number: number; text: string }[]; review_reason?: string; approved_by?: string; series_id: string }
export type Doctor = Entity & { name: string; display_name: string; specialty: string; background_type: string; public_facts: string; sources: string[]; population: string; focus: string; training_style: string; mood: string; opening: string }
export type Dimension = { key: string; label: string; weight: number; anchors: string[]; requires_content: boolean }
export type Rubric = Entity & { name: string; dimensions: Dimension[]; calibration_status: string }
export type Scenario = Entity & { title: string; product: string; disease: string; objective: string; doctor_id: string; rubric_id: string; content_ids: string[]; stages: string[]; duration_seconds: number; difficulty: string; situation?:string; background?:string; opening?:string; objections?:string[]; success_criteria?:string[]; generation?:{model:string;elapsed_seconds:number;usage:{total_tokens?:number};cost?:{totals:Record<string,string>;status:string};citations:{document_id:string;title:string;version_label:string;page:number;quote:string}[]} }
export type CatalogRecord = Content | Doctor | Rubric | Scenario
export type TrainingCase = Entity & { title:string;situation:string;approach:string;rationale:string;limitations:string;origin_verified:boolean;origin_record_id?:string;quotes:{role:string;text:string}[] }
export const kindLabels: Record<Kind, string> = { content: '训练资料', doctor: '医生角色', rubric: '评分标准', scenario: '训练场景' }
export const statusLabels: Record<string, string> = { draft: '草稿', submitted: '待核对', approved: '已核对', rejected: '待修改', retired: '已停用', published: '已发布' }
export const stages: Record<string, string> = { opening: '开场', needs: '需求探询', evidence: '研究介绍', objections: '异议处理', safety: '安全沟通', closing: '收尾' }
export const situations: Record<string, string> = { first_visit:'首次拜访', follow_up:'复访', time_pressure:'时间紧张', evidence_challenge:'证据质疑' }
export function titleOf(item: CatalogRecord) { return 'title' in item ? item.title : 'display_name' in item ? item.display_name : item.name }
export type TrainingSnapshot = {
  scenario: { id:string; title:string; product:string; disease:string; objective:string; duration_seconds:number; background?:string; situation?:string }
  doctor: { id:string; display_name:string; specialty:string; public_facts:string; population:string; focus:string; training_style:string; mood:string; sources:string[] }
  rubric: { id:string; name:string; calibration_status:string }
  documents: { id:string; title:string; version_label:string }[]
  stage:string
}
export type Assessment = {
  evaluator_version:string; model:string; rubric_id:string; rubric_name:string; rubric_fingerprint:string; calibration_status:string
  status:'complete'|'partial'|'unavailable'; total:number|null; observed_weight:number; validation_errors:string[]
  dimensions:{key:string;label:string;weight:number;score:number|null;reason:string;anchor:string|null;utterances:{message_id:string;quote:string}[];citations:{id:string;document_id:string;document_version:number;title:string;version_label:string;page:number;quote:string;source_url:string}[]}[]
}
