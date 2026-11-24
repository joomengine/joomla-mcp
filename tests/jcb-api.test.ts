import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../src/config/schema.js';
import { JoomlaApiError } from '../src/infrastructure/api/joomla-api-error.js';
import type { JoomlaApiResponse, JoomlaApiTransport } from '../src/infrastructure/api/joomla-api-client.js';
import { getJcbApiAction } from '../src/jcb/catalog.js';
import { applyJcbApiWrite, prepareJcbApiWrite, probeJcbApiResource, readJcbApiAction, resolveJcbApiRequest } from '../src/jcb/api.js';
import { jcbInputSchema } from '../src/jcb/api-input.js';

const apiConfig: ApiConfig = {baseUrl:'https://cms.example/joomla',tokenEnv:'TEST',token:'test',
  timeoutMs:1000,maxResponseBytes:100000,maxPageSize:3};
const key = '1db54972-0003-4643-92da-dac1b45449e4';

function action(id: string) {
  const descriptor = getJcbApiAction('jcb.api.'+id);
  if (!descriptor) throw new Error('Test action missing: '+id);
  return descriptor;
}

function response(data: unknown,status=200,headers: Record<string,string>={}): JoomlaApiResponse {
  return {data,status,headers};
}

function item(id: string, attributes: Record<string,unknown>,type='languages'): JoomlaApiResponse {
  return response({data:{id,type,attributes}});
}

function transport() {
  return {get:vi.fn<JoomlaApiTransport['get']>(),request:vi.fn<JoomlaApiTransport['request']>()};
}

describe('JCB Web Services', () => {
  it('resolves only native filters, ordering and bounded page sizes', async () => {
    const fields=action('fields.list');
    const request=resolveJcbApiRequest(fields,{filter:{datatype:['INT','CHAR']},ordering:'id',direction:'DESC',limit:5},3);
    expect(request).toMatchObject({method:'GET',path:'v1/componentbuilder/fields',query:{
      'filter[datatype][]':['INT','CHAR'],'list[ordering]':'id','list[direction]':'desc','page[limit]':3,'page[offset]':0}});
    expect(() => resolveJcbApiRequest(fields,{filter:{unsupported:'value'}})).toThrow('Unknown list filter');
    expect(() => resolveJcbApiRequest(fields,{filter:{datatype:[['nested']]}})).toThrow('scalar');
    expect(() => resolveJcbApiRequest(fields,{ordering:'unregistered'})).toThrow();
    expect(() => resolveJcbApiRequest(fields,{baseUrl:'elsewhere'})).toThrow();
    expect(jcbInputSchema(fields)).toHaveProperty('properties.filter.properties.datatype');
  });

  it('checks independently returned GUID and numeric identity',async () => {
    const api=transport();
    const read=action('admin_views.get.guid');
    expect(resolveJcbApiRequest(read,{guid:key}).path).toBe('v1/componentbuilder/admin_views/guid/'+key);
    expect(() => resolveJcbApiRequest(read,{guid:'invalid'})).toThrow();
    api.get.mockResolvedValue(item('7',{guid:'114dbb06-712d-49b5-a07c-ffd96725c07d'}));
    await expect(readJcbApiAction(api,apiConfig,read,{guid:key})).rejects.toThrow('different');
    const numeric=action('languages.get');
    expect(() => resolveJcbApiRequest(numeric,{id:0})).toThrow();
    expect(() => resolveJcbApiRequest(numeric,{id:'1/2'})).toThrow();
    api.get.mockResolvedValue(response({data:{id:'7',type:'languages',attributes:{id:'8'}}}));
    await expect(readJcbApiAction(api,apiConfig,numeric,{id:7})).rejects.toThrow('inconsistent');
  });

  it('checks collection format and withholds native credential values',async () => {
    const api=transport();
    const list=action('repositories.list');
    api.get.mockResolvedValue(response('<html>Joomla login</html>'));
    expect(await probeJcbApiResource(api,apiConfig,list)).toBe(false);
    api.get.mockResolvedValue(response({data:[{id:'2',type:'repositories',attributes:{token:'secret',system_name:'docs'}}]}));
    expect(await probeJcbApiResource(api,apiConfig,list)).toBe(true);
    const out=await readJcbApiAction(api,apiConfig,list,{});
    expect(JSON.stringify(out)).toContain('docs');
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('refuses unregistered, authority and nested form fields',() => {
    const edit=action('languages.update');
    expect(() => resolveJcbApiRequest(edit,{id:1,data:{not_a_field:1}})).toThrow();
    expect(() => resolveJcbApiRequest(edit,{id:1,data:{rules:{}}})).toThrow();
    expect(() => resolveJcbApiRequest(edit,{id:1,data:{id:9}})).toThrow();
    const translation=action('language_translations.update');
    expect(() => resolveJcbApiRequest(translation,{id:1,data:{translation:[{bogus:'v'}]}})).toThrow('bogus');
    expect(() => resolveJcbApiRequest(translation,{id:1,data:{translation:[{language:'en-GB',translation:'new text'}]}})).not.toThrow();
  });

  it('binds preconditions and verifies an independently read approved field',async () => {
    const api=transport();
    const edit=action('languages.update');
    const old=item('7',{name:'Before'});
    const updated=item('7',{name:'After'});
    api.get.mockResolvedValueOnce(old).mockResolvedValueOnce(old).mockResolvedValueOnce(updated);
    api.request.mockResolvedValue(response(null,204));
    const plan=await prepareJcbApiWrite(api,apiConfig,edit,{id:7,data:{name:'After'}});
    expect(plan.preview.fields).toEqual(['name']);
    expect(JSON.stringify(plan.preview)).not.toContain('After');
    const result=await applyJcbApiWrite(api,apiConfig,edit,plan,key);
    expect(api.request).toHaveBeenCalledExactlyOnceWith(apiConfig,{method:'PATCH',path:'v1/componentbuilder/languages/7',body:{name:'After'},idempotencyKey:key});
    expect(result.verification).toMatchObject({status:'verified',id:'7',fields:['name']});
  });

  it('stops stale approval before sending any write',async () => {
    const api=transport();
    const edit=action('languages.update');
    api.get.mockResolvedValueOnce(item('7',{name:'old'})).mockResolvedValueOnce(item('7',{name:'changed'}));
    const plan=await prepareJcbApiWrite(api,apiConfig,edit,{id:7,data:{name:'requested'}});
    await expect(applyJcbApiWrite(api,apiConfig,edit,plan,key)).rejects.toThrow('changed');
    expect(api.request).not.toHaveBeenCalled();
  });

  it('retains the original translation source while verifying nested translations',async () => {
    const api=transport();
    const edit=action('language_translations.update');
    const translation=[{language:'en-GB',translation:'Text'}];
    const old=item('7',{source:'FIXED_SOURCE',translation:[]});
    const saved=item('7',{source:'FIXED_SOURCE',translation:JSON.stringify(translation)});
    api.get.mockResolvedValueOnce(old).mockResolvedValueOnce(old).mockResolvedValueOnce(saved);
    api.request.mockResolvedValue(response(null,204));
    const plan=await prepareJcbApiWrite(api,apiConfig,edit,{id:7,data:{translation}});
    expect(plan.request.body).toEqual({translation,source:null});
    expect(plan.preview.fields).toEqual(['translation']);
    expect((await applyJcbApiWrite(api,apiConfig,edit,plan,key)).verification.status).toBe('verified');
    await expect(prepareJcbApiWrite(api,apiConfig,edit,{id:7,data:{source:'mutated'}})).rejects.toThrow('read-only');
  });

  it('requires independent confirmation of accepted creates, without following response URLs',async () => {
    const api=transport();
    const create=action('languages.create');
    const plan=await prepareJcbApiWrite(api,apiConfig,create,{data:{name:'Example',langtag:'xx-AB'}});
    api.request.mockResolvedValue(response(null,201,{location:'https://foreign.example/api/index.php/v1/componentbuilder/languages/11'}));
    expect((await applyJcbApiWrite(api,apiConfig,create,plan,key)).verification.status).toBe('uncertain');
    expect(api.get).not.toHaveBeenCalled();
    api.request.mockResolvedValue(response(null,201,{location:'https://cms.example/joomla/api/index.php/v1/componentbuilder/languages/11'}));
    api.get.mockResolvedValue(item('11',{name:'Other',langtag:'xx-AB'}));
    expect((await applyJcbApiWrite(api,apiConfig,create,plan,key)).verification).toMatchObject({status:'uncertain',id:'11'});
  });

  it('keeps ambiguous effects uncertain and verifies native deletes independently',async () => {
    const api=transport();
    const remove=action('languages.delete');
    const existing=item('7',{name:'old'});
    api.get.mockResolvedValueOnce(existing).mockResolvedValueOnce(existing)
      .mockRejectedValueOnce(new JoomlaApiError(404,null)).mockResolvedValueOnce(response({data:[]}));
    api.request.mockResolvedValue(response(null,204));
    const plan=await prepareJcbApiWrite(api,apiConfig,remove,{id:7});
    expect((await applyJcbApiWrite(api,apiConfig,remove,plan,key)).verification).toMatchObject({status:'verified',id:'7'});
    api.get.mockResolvedValue(existing);
    api.request.mockRejectedValue(new Error('remote response dropped'));
    expect((await applyJcbApiWrite(api,apiConfig,remove,plan,key)).verification.status).toBe('uncertain');
  });
});
