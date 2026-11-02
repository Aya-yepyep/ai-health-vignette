// Descriptive display rules only: these cutoffs have not been validated.
export const RULE_VERSION = 'ert-descriptive-2026-11-02-v2';
export const LEGACY_RULE_VERSION = 'ert-descriptive-2026-11-02-v1';
export const SUPPORTED_RULES = [RULE_VERSION, LEGACY_RULE_VERSION];
export const TYPES = [
  {id:'ERT_ABSTAIN', name:'认识性拒认型', short:'暂不采用AI',
    explanation:'在这次情景中，你更倾向暂不把AI回应纳入判断。这描述的是本次选择，并不表示你普遍拒绝AI。'},
  {id:'ERT_INSTRUMENT', name:'工具性依赖型', short:'工具辅助',
    explanation:'你倾向让AI帮助整理信息，同时把评价信息是否可信的判断保留在自己这里。'},
  {id:'ERT_CONTINGENT', name:'条件性委托型', short:'有边界地委托',
    explanation:'你倾向在自己明确的条件内把部分判断任务交给AI；条件不满足时，会考虑收回这些任务。'},
  {id:'ERT_COAGENCY', name:'协同代理型', short:'共同探究',
    explanation:'你倾向通过与AI反复讨论来调整理解和判断。这不代表已经完成充分核验，也不意味着AI与人承担相同责任。'},
  {id:'ERT_DISPLACE', name:'权威替代型', short:'结论主导',
    explanation:'你这次更倾向主要沿用AI结论，即使暂时难以说明它为什么合理。这不是对你能力或稳定人格的评价。'},
];

const legacyDimensions = [
  {id:'JD',name:'判断委托',ids:['JD_1','JD_2','JD_3','JD_4','JD_5','JD_6','JD_R1'],
    meaning:'分数越高，表示这次越愿意把信息整理、比较和部分判断任务交给AI。'},
  {id:'EC',name:'认识控制',ids:['EC_1','EC_2','EC_3','EC_4','EC_5','EC_6','EC_7','EC_8','EC_R1'],
    meaning:'分数越高，表示你自评越有条件理解、核验、质疑或拒绝AI回应；它不是实测能力分数。'},
  {id:'EA',name:'主动参与',ids:['EA_1','EA_2','EA_3','EA_4','EA_5','EA_R1'],
    meaning:'分数越高，表示这次越愿意主动思考、追问和核验；它是意向，不是已经发生的行为。'},
];
const currentIds = {JD:['JD_1','JD_3','JD_6'],EC:['EC_1','EC_3','EC_8'],EA:['EA_1','EA_3','EA_4']};
const dimensions = legacyDimensions.map(d=>({...d,ids:currentIds[d.id]}));
const actionLabels = {
  accept_order:'沿用模拟AI的排序继续', verify_first:'先核对关键依据再决定',
  revise_together:'自己重排，并请模拟AI补充', pause_ai:'暂不采用这次模拟建议',
};

function score(answers,id) {
  const value = answers?.[id];
  if (!Number.isInteger(value) || value<1 || value>7) throw new Error('Feedback requires complete valid answers');
  return value;
}

export function buildFeedback(answers,{ruleVersion=RULE_VERSION}={}) {
  if(!SUPPORTED_RULES.includes(ruleVersion))throw new Error('Unsupported feedback rule');
  const selectedDimensions=ruleVersion===LEGACY_RULE_VERSION?legacyDimensions:dimensions;
  const indicators = TYPES.map(type=>({...type,score:score(answers,type.id)}));
  const ranked = [...indicators].sort((a,b)=>b.score-a.score);
  const top = ranked[0], second = ranked[1];
  const close = ranked.filter(item=>item.score>=5 && top.score-item.score<=1);
  let kind, title, explanation;
  if (top.score<=4) {
    kind='unclear'; title='尚未显现明确的协作类型';
    explanation='五种互动方式均未达到本页规则中的较明显认可范围。可能是这些方式都不完全贴合你，也可能是你对这次情景仍有保留；不能据此断言你没有协作能力。';
  } else if (top.score-second.score>=2) {
    kind='prominent'; title=`当前较突出：${top.name}`;
    explanation=top.explanation;
  } else if (close.length>1) {
    kind='mixed'; title='混合或接近的协作倾向';
    explanation=`你对${close.map(item=>`“${item.name}”`).join('、')}的认可较接近，单凭这些回答无法把你稳定归入某一类。多种互动方式也可能随任务环节而变化。`;
  } else {
    kind='tentative'; title=`倾向尚不清晰，最接近${top.name}`;
    explanation=`${top.explanation}但它与其他方式的得分差距不足本页规则要求，暂不将其作为明确类型。`;
  }
  return {rule_version:ruleVersion,kind,title,explanation,
    action_summary:ruleVersion===RULE_VERSION?actionLabels[answers.scenario_final_plan]||null:null,
    evidence:kind==='prominent' || kind==='tentative'
      ? `你对“${top.name}”的回答是${top.score}/7，第二高为${second.score}/7。`
      : kind==='mixed' ? close.map(item=>`${item.name} ${item.score}/7`).join('；') : `最高得分为${top.score}/7。`,
    indicators, dimensions:selectedDimensions.map(d=>({id:d.id,name:d.name,meaning:d.meaning,
      mean:d.ids.reduce((sum,id)=>sum+(id.endsWith('_R1')?8-score(answers,id):score(answers,id)),0)/d.ids.length})),
  };
}

export function appendFeedback(parent, feedback, doc=document) {
  if (!SUPPORTED_RULES.includes(feedback?.rule_version)) return;
  const add = (tag,text,container=parent,className) => {
    const node=doc.createElement(tag); node.textContent=text;
    if (className) node.className=className;
    container.append(node); return node;
  };
  const section=doc.createElement('section'); section.className='feedback'; parent.append(section);
  add('p','你的本次人机协作反馈',section,'eyebrow');
  add('h2',feedback.title,section);
  add('p',feedback.explanation,section);
  add('p',feedback.evidence,section,'notice');
  if(feedback.action_summary)add('p',`回看你在模拟情景中的最后选择：${feedback.action_summary}。这是一次具体选择的回顾，独立于下面的自报类型规则。`,section,'notice');
  add('p','这是新编规则生成的探索性反馈，只描述当前情景的自报倾向。五类没有优劣或能力高低之分，不能作为经过验证的科研分类、稳定人格或健康判断。',section,'helper');
  add('h3','你如何分担判断任务',section);
  for (const dimension of feedback.dimensions) {
    add('p',`${dimension.name}：${dimension.mean.toFixed(1)} / 7`,section,'feedback-score');
    add('p',dimension.meaning,section,'helper');
  }
  const details=doc.createElement('details'); section.append(details);
  add('summary','查看五类得分和反馈规则',details);
  for (const item of feedback.indicators) {
    add('p',`${item.name}（${item.short}）：${item.score} / 7`,details,'feedback-score');
    add('p',item.explanation,details,'helper');
  }
  add('p','每种倾向只对应一道1—7分题，分数越高代表越认可这次采取该方式；它们不是五选一。最高分≤4时显示不明显；最高≥5且领先第二名至少2分时显示该倾向；否则显示接近、混合或不清晰。5分与2分差距是本次显示规则的选择，未经分类效度验证。',details,'helper');
  add('p',feedback.rule_version===LEGACY_RULE_VERSION
    ?'判断委托、认识控制和主动参与分别取原版本对应条目均值；各组反向题先用8减去原分。三个均值只帮助解释，不参与类型加权，也没有人群常模。'
    :'判断委托、认识控制和主动参与分别取三道保留题的均值，当前精简稿没有反向题。三个均值只帮助解释，不参与类型加权，也没有人群常模；精简稿仍需重新检验信效度。',details,'helper');
  add('p',`问卷结果规则：${feedback.rule_version}。原始答卷保留在研究数据库；本页反馈仅在当前标签页生成和临时保存，清除本页记录后不能凭提交凭证重新查询。`,details,'helper');
}
