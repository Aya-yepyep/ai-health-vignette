// Controlled, prewritten interaction. No live model requests or medical advice.
export function scenarioFieldIds(session) {
  return (session?.condition?.scenario_steps || []).map(step=>step.field_id).filter(id=>typeof id==='string');
}

export function mountScenario({app,session,manifest,draft,persist,screen,onDone,onExit}) {
  const steps=session.condition.scenario_steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error('Missing scenario steps');
  const fields=new Map(session.fields.map(field=>[field.id,field]));
  if (!draft.journey || !Number.isInteger(draft.journey.index)) draft.journey={index:0,viewed:{}};
  const journey=draft.journey;
  journey.index=Math.max(0,Math.min(steps.length-1,journey.index));
  if (!journey.viewed || typeof journey.viewed!=='object') journey.viewed={};
  const node=(tag,text,className)=>{
    const element=document.createElement(tag);
    if(text!==undefined)element.textContent=text;
    if(className)element.className=className;
    return element;
  };
  const action=(text,fn,className='button')=>{
    const button=node('button',text,className);button.type='button';button.addEventListener('click',fn);return button;
  };
  const label=(field,value)=>manifest.field_labels?.[field.id]?.options?.[value] || value;
  const render=()=>{
    const step=steps[journey.index],field=fields.get(step.field_id);
    screen(step.title,{step:journey.index+1,total:steps.length,phase:'情景进度'});
    app.append(node('p','预写模拟互动 · 回应由研究者编写，不连接实时AI。选择没有标准答案。','helper'));
    if(step.body)app.append(node('div',step.body,'vignette'));
    const navigation=node('div',undefined,'actions');
    const buttons=node('div',undefined,'action-group');
    const next=action(journey.index===steps.length-1?'完成情景，谈谈你的看法':'继续下一步',()=>{
      if(!ready())return;
      persist();
      if(journey.index===steps.length-1){onDone();return;}
      journey.index++;persist();render();
    });
    const sourceIds=(step.sources||[]).map(source=>source.id);
    const ready=()=> (!field || field.options.includes(draft.answers[field.id])) &&
      sourceIds.every(id=>journey.viewed[id]===true);
    const updateReady=()=>{next.disabled=!ready();};
    if(sourceIds.length){
      app.append(node('p','点击两张资料卡查看内容，再选择你想先做什么。','helper'));
      const cards=node('div',undefined,'source-grid');
      for(const source of step.sources){
        const details=node('details',undefined,'source-card');
        details.append(node('summary',source.title),node('p',source.body));
        if(journey.viewed[source.id])details.open=true;
        details.addEventListener('toggle',()=>{
          if(details.open){journey.viewed[source.id]=true;persist();updateReady();}
        });
        cards.append(details);
      }
      app.append(cards);
    }
    if(step.kind==='dialogue'){
      const firstField=fields.get('scenario_first_action');
      if(firstField && draft.answers[firstField.id])app.append(node('p',`你刚才选择：${label(firstField,draft.answers[firstField.id])}。下面先查看共同的模拟提问与初步回应，再选择你想追问的方向。`,'notice'));
      app.append(node('p','你的提问','chat-label'),node('div',step.user_prompt,'chat-message chat-user'),
        node('p','模拟AI','chat-label'),node('div',step.ai_response,'chat-message chat-ai'));
    }
    if(field){
      const group=node('fieldset',undefined,'question journey-choice');
      group.append(node('legend',field.label));
      const response=node('div');response.setAttribute('aria-live','polite');
      if(step.kind==='dialogue'){
        const choices=node('div',undefined,'question-chips'),all=[];
        const show=()=>{
          const value=draft.answers[field.id],branch=(step.branches||[]).find(item=>item.value===value);
          response.replaceChildren();
          for(const [button,option] of all)button.setAttribute('aria-pressed',String(option===value));
          if(branch)response.append(node('p',`你追问：${label(field,value)}`,'chat-label'),node('div',branch.response,'chat-message chat-ai'));
          updateReady();
        };
        for(const value of field.options){
          const button=action(label(field,value),()=>{draft.answers[field.id]=value;persist();show();},'button secondary');
          all.push([button,value]);choices.append(button);
        }
        group.append(choices,response);app.append(group);show();
        app.append(node('p','可以查看不同追问的模拟回应；提交时记录你最后选中的追问，不记录完整点击过程。','helper'));
      } else {
        const choices=node('div',undefined,'choices');
        field.options.forEach((value,index)=>{
          const option=node('label',undefined,'option');const input=node('input');
          input.type='radio';input.name=field.id;input.value=value;input.id=`journey-${field.id}-${index}`;
          input.checked=draft.answers[field.id]===value;
          input.addEventListener('change',()=>{draft.answers[field.id]=value;persist();updateReady();});
          option.append(input,node('span',label(field,value)));choices.append(option);
        });
        group.append(choices);app.append(group);
      }
    }
    if(journey.index>0)buttons.append(action('返回上一步',()=>{journey.index--;persist();render();},'button secondary'));
    buttons.append(next);navigation.append(action('退出并清除进度',onExit,'button text'),buttons);app.append(navigation);
    updateReady();
  };
  render();
}
