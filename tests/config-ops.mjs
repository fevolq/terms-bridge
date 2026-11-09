// Test helper: exercise the same field-level edits used by the settings page.
export function projectOperations(current, next) {
 const ops=[];
 for(const id of Object.keys(current)) if(!Object.hasOwn(next,id)) ops.push({op:'unset',path:['projects',id]});
 for(const [id,project] of Object.entries(next)) {
  if(!Object.hasOwn(current,id)){ops.push({op:'set',path:['projects',id],value:project});continue;}
  for(const key of new Set([...Object.keys(current[id]),...Object.keys(project)])) {
   if(['workspace_path','created_at'].includes(key))continue;
   ops.push(project[key]===undefined?{op:'unset',path:['projects',id,key]}:{op:'set',path:['projects',id,key],value:project[key]});
  }
 }
 return ops;
}
