// Independent finite probes, kept outside worker inputs until final grading.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function installProbe(root,task){
 const dir='packages/query-core/src/__tests__/',name=task.id==='mutation-callbacks'?'study-hidden-error.test.ts':'study-hidden-filter.test-d.ts';
 const source=task.id==='mutation-callbacks'?`
import {expect,it,vi} from 'vitest';
import {MutationObserver,QueryClient} from '..';
it('reentrant error callbacks retain each mutation context and settlement',async()=>{
 vi.useFakeTimers();const client=new QueryClient();client.mount();
 try{
  const error=new Error('first'),first=vi.fn(),second=vi.fn();
  const observer=new MutationObserver(client,{
   mutationFn:async(value:number)=>{if(value===1)throw error;return value;},
   onMutate:async(value:number)=>({value})
  });
  const stop=observer.subscribe(()=>{});
  let next:Promise<number>|undefined;
  const failed=observer.mutate(1,{onError:()=>{next=observer.mutate(2,{onSettled:second});},onSettled:first}).catch(e=>e);
  await vi.runAllTimersAsync();await failed;await next;
  expect(first).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledWith(undefined,error,1,{value:1},expect.objectContaining({client}));
  expect(second).toHaveBeenCalledWith(2,null,2,{value:2},expect.objectContaining({client}));
  stop();
 }finally{client.clear();client.unmount();vi.useRealTimers();}
});
`:`
import {QueryClient} from '..';import {useIsFetching} from '@tanstack/react-query';
const client=new QueryClient();
const a:number=client.isFetching({queryKey:['records',1] as const,exact:true,type:'inactive',stale:false,predicate:q=>q.state.fetchStatus==='fetching'});
const b:number=useIsFetching({queryKey:['records'],exact:false,type:'all',stale:true,predicate:q=>q.queryKey.length>0},client);
client.getQueryCache().findAll({fetchStatus:'idle',exact:true});
client.getQueryCache().findAll({fetchStatus:'paused'});
// @ts-expect-error counting APIs override this field internally
client.isFetching({exact:true,fetchStatus:'idle'});
// @ts-expect-error the React filter excludes the same field
useIsFetching({stale:false,fetchStatus:'fetching'},client);
void a;void b;
`;
 const path=dir+name;await writeFile(join(root,path),source);return path;
}
