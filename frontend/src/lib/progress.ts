export const providerLabels:Record<string,string>={deepseek:'DeepSeek 分析','seedasr':'语音识别','doubao-tts':'医生语音合成','doubao-duplex':'实时语音对话'}
export const unitLabels:Record<string,string>={input_tokens:'输入 token',output_tokens:'输出 token',audio_seconds:'识别音频秒数',text_characters:'提交合成的字符数',search_requests:'搜索请求',fetch_requests:'网页读取请求'}
export type PriceRate={provider:string;model:string;unit:string;amount:string;per_units:number;currency:string;source_url:string;checked_on:string;note:string}
export type PriceBook={version:number;rates:PriceRate[]}
export type Cost={status:string;totals:Record<string,string>;missing:string[];lines:{provider:string;model:string;unit:string;quantity:string;amount:string;currency:string;rate:PriceRate}[]}
export function costLabel(totals:Record<string,string>){return Object.entries(totals).map(([currency,amount])=>`${currency} ${amount}`).join(' + ')||'尚无已计价用量'}
export type ProgressData={days:number;session_count:number;completed_count:number;valid_practice_count:number;duration_seconds:number;unknown_duration_count:number;cost_totals:Record<string,string>;unpriced_session_count:number;
  groups:{scenario_title:string;stage:string;experience:string;attempts:number;model:string;calibration_status:string;first_record_id:string;latest_record_id:string;latest_at:string;comparable:boolean;dimensions:{key:string;label:string;before:number|null;after:number|null;delta:number|null}[]}[];
  sessions:{id:string;started_at:string;scenario_title:string|null;status:string;duration_seconds:number|null;validation_only:boolean;cost:Cost;usage:{provider?:string;model?:string;prompt_tokens?:number;completion_tokens?:number;input_tokens?:number;output_tokens?:number;audio_seconds?:number;submitted_characters?:number;elapsed_seconds?:number}[]}[]}
