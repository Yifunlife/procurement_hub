import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './procurement.test.mjs';

test('admin can select production stages before supplier confirmation; other roles retain restrictions',async()=>{
 const {db,request}=fixture();
 const path='/orders/order/items/item-0/production';
 assert.equal((await request('buyer',path,{workflowStage:'in_production'})).status,409);
 db.exec("INSERT INTO staff_roles VALUES('buyer','admin'); INSERT INTO attachments (id,order_id,item_id,kind,file_name,content_type,r2_key,uploaded_by,created_at) VALUES ('stage-photo','order','item-0','production_photo','real.png','image/png','stage-photo','buyer','2026-09-03')");
 for(const workflowStage of ['in_production','production_complete','ready_to_ship','queued']) {
   assert.equal((await request('buyer',path,{workflowStage})).status,200);
   assert.equal(db.prepare("SELECT workflow_stage FROM order_items WHERE id='item-0'").get().workflow_stage,workflowStage);
 }
 assert.equal((await request('buyer',path,{workflowStage:'shipment_complete'})).status,409);
 db.exec("UPDATE purchase_orders SET archived_at='2026-09-03' WHERE id='order'");
 assert.equal((await request('buyer',path,{workflowStage:'in_production'})).status,404);
});

test('procurement supplier operations synchronizes pending orders and can accept completed products', async () => {
 const {db,request}=fixture();
 db.exec("INSERT INTO staff_permissions(user_id,supplier_operations) VALUES ('buyer',1)");
 const photo=new FormData();
 photo.set('kind','production_photo'); photo.set('itemId','item-0');
 photo.set('file',new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64')],'real.png',{type:'image/png'}));
 assert.equal((await request('buyer','/orders/order/attachments',photo,'POST')).status,201);
 const production='/orders/order/items/item-0/production';
 assert.equal((await request('buyer',production,{workflowStage:'production_complete'},'PATCH')).status,200);
 assert.equal(db.prepare("SELECT status FROM purchase_orders WHERE id='order'").get().status,'in_production');
 const revision=db.prepare("SELECT production_revision FROM order_items WHERE id='item-0'").get().production_revision;
 assert.equal((await request('buyer','/orders/order/items/item-0/acceptance',{decision:'approved',reason:'',revision},'POST')).status,200);
 assert.equal(db.prepare("SELECT status FROM purchase_orders WHERE id='order'").get().status,'ready_to_ship');
});

test('corrections reverse in dependency order, preserve records, reject stale retries and permit re-entry',async()=>{
 const {db,request}=fixture(); db.exec("INSERT INTO staff_roles VALUES('buyer','admin')");
 const base='/orders/order/items/item-0';
 assert.equal((await request('buyer',base+'/acceptance',{decision:'approved',revision:0},'POST')).status,200);
 for(const action of ['received','stocked']) assert.equal((await request('buyer',base+'/warehouse',{action,quantity:3,requestId:'initial-'+action+'-0000001'},'POST')).status,200);
 const snapshot=()=>db.prepare("SELECT production_revision revision,received_quantity received,stocked_quantity stocked FROM order_items WHERE id='item-0'").get();
 const correction=(action,quantity=1)=>({action,quantity,reason:'误按测试',...snapshot(),requestId:crypto.randomUUID()});
 const post=(body,user='buyer')=>request(user,base+'/corrections',body,'POST');
 assert.equal((await post(correction('received'))).status,409);
 assert.equal((await post(correction('acceptance'))).status,409);
 for(const user of ['vendor','finance']) assert.equal((await post(correction('stocked'),user)).status,403);
 for(const quantity of [0,-1,1.5,4]) assert.ok([400,409].includes((await post(correction('stocked',quantity))).status));
 assert.equal((await post({...correction('stocked'),reason:''})).status,400);
 const stale=correction('stocked'); const first=correction('stocked',3);
 assert.equal((await post(first)).status,200);
 assert.equal((await post(first)).status,200);
 assert.equal((await post(stale)).status,409);
 assert.equal((await post(correction('received',3))).status,200);
 assert.equal((await post(correction('acceptance'))).status,200);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouse_records').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM product_acceptances').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM item_corrections').get().n,3);
 assert.throws(()=>db.exec('DELETE FROM item_corrections'),/不可删除/);
 assert.throws(()=>db.exec("UPDATE item_corrections SET reason='overwrite'"),/不可覆盖/);
 assert.equal((await request('buyer',base+'/acceptance',{decision:'approved',revision:snapshot().revision},'POST')).status,200);
 assert.equal((await request('buyer',base+'/warehouse',{action:'received',quantity:2,requestId:crypto.randomUUID()},'POST')).status,200);
 db.exec("UPDATE staff_roles SET role='warehouse' WHERE user_id='buyer'");
 const dashboard=await (await request('buyer','/dashboard',undefined,'GET')).json();
 assert.equal(dashboard.orders[0].items.find(i=>i.id==='item-0').production_revision,snapshot().revision);
 assert.equal((await post(correction('acceptance'))).status,403);
 assert.equal((await post(correction('received',2))).status,200);
 db.exec("UPDATE purchase_orders SET archived_at='2026-09-03' WHERE id='order'");
 assert.equal((await post(correction('received'))).status,409);
});

test('scene images are procurement-uploaded and visible only to the matching supplier', async () => {
 const {db,request}=fixture();
 const form=new FormData(); form.set('kind','scene_image');
 form.set('file',new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64')],'scene.png',{type:'image/png'}));
 assert.equal((await request('vendor','/orders/order/attachments',form,'POST')).status,403);
 const res=await request('buyer','/orders/order/attachments',form,'POST'); assert.equal(res.status,201);
 const {attachmentId}=await res.json();
 const data=await (await request('vendor','/dashboard',undefined,'GET')).json();
 assert.ok(data.orders[0].attachments.some(a=>a.id===attachmentId && a.purpose==='scene'));
 assert.equal((await request('vendor','/attachments/'+attachmentId,undefined,'GET')).status,200);
 assert.equal((await request('other','/attachments/'+attachmentId,undefined,'GET')).status,404);
 assert.equal(db.prepare("SELECT production_revision FROM order_items WHERE id='item-0'").get().production_revision,0);
 const bad=new FormData(); bad.set('kind','scene_image'); bad.set('file',new File(['%PDF-test'],'scene.pdf',{type:'application/pdf'}));
 assert.equal((await request('buyer','/orders/order/attachments',bad,'POST')).status,400);
});

test('freight status is procurement-owned, revision checked and audited',async()=>{
 const {db,request}=fixture(); const path='/orders/order/items/item-0/freight-payment';
 for(const user of ['vendor','finance']) assert.equal((await request(user,path,{status:'paid',revision:0})).status,403);
 assert.equal((await request('buyer',path,{status:'unpaid',revision:0})).status,200);
 assert.equal((await request('buyer',path,{status:'paid',revision:0})).status,409);
 assert.equal((await request('buyer',path,{status:'paid',revision:1})).status,200);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM order_events WHERE event_type='freight_payment'").get().n,2);
 assert.equal(db.prepare("SELECT freight_payment_status FROM order_items WHERE id='item-0'").get().freight_payment_status,'paid');
 db.exec("UPDATE purchase_orders SET archived_at='2026-09-03' WHERE id='order'");
 assert.equal((await request('buyer',path,{status:'unpaid',revision:2})).status,404);
});

test('packaging volume is saved per product by procurement and audited',async()=>{
 const {db,request}=fixture(); const path='/orders/order/items/item-0/packaging-volume';
 for(const user of ['vendor','finance']) assert.equal((await request(user,path,{volume:'0.5 m³',revision:0})).status,403);
 assert.equal((await request('buyer',path,{volume:'0.5 m³',revision:0})).status,200);
 assert.equal((await request('buyer',path,{volume:'0.8 m³',revision:0})).status,409);
 assert.equal((await request('buyer',path,{volume:'0.8 m³',revision:1})).status,200);
 const item=db.prepare("SELECT packaging_volume,packaging_volume_revision FROM order_items WHERE id='item-0'").get();
 assert.equal(item.packaging_volume,'0.8 m³'); assert.equal(item.packaging_volume_revision,2);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM order_events WHERE event_type='packaging_volume'").get().n,2);
});

test('supplier profile can be created and edited without a login, then activated later', async () => {
  const {db,request}=fixture();
  const profile={name:'无邮箱供应商',contactName:'联系人',contactInfo:'电话',purchaserName:'采购',products:[]};
  const created=await request('buyer','/suppliers',profile,'POST'); assert.equal(created.status,201);
  const {supplierId,supplierCode}=await created.json();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE supplier_id=?').get(supplierId).n,0);
  assert.equal((await request('buyer','/suppliers/'+supplierId,{...profile,name:'更新名称'})).status,200);
  assert.equal((await request('buyer','/suppliers/'+supplierId,{...profile,email:'new@example.test'})).status,400);
  assert.equal((await request('buyer','/suppliers/'+supplierId,{...profile,email:'new@example.test',password:'test-password'})).status,200);
  assert.equal(db.prepare('SELECT code FROM suppliers WHERE id=?').get(supplierId).code,supplierCode);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE supplier_id=?').get(supplierId).n,1);
  assert.equal((await request('buyer','/suppliers/'+supplierId,profile)).status,400);
  for(const extra of [{email:'invalid',password:'test-password'},{email:'valid@example.test'},{password:'test-password'}]) assert.equal((await request('buyer','/suppliers',{...profile,...extra},'POST')).status,400);
});

test('admin may accept and receive before production and shipping, with bounded quantities and audit', async () => {
  const {db,request} = fixture();
  const accept = {decision:'approved',reason:'',revision:0};
  assert.equal((await request('buyer','/orders/order/items/item-0/acceptance',accept,'POST')).status,409);
  db.exec("INSERT INTO staff_roles VALUES ('buyer','warehouse')");
  const receipt={action:'received',quantity:2,requestId:'early-receipt-00001'};
  assert.equal((await request('buyer','/orders/order/items/item-0/warehouse',receipt,'POST')).status,409);
  db.exec("UPDATE staff_roles SET role='admin' WHERE user_id='buyer'");
  assert.equal((await request('buyer','/orders/order/items/item-0/acceptance',accept,'POST')).status,200);
  assert.equal(db.prepare('SELECT reason FROM product_acceptances').get().reason,'管理员直接验收');
  assert.equal((await request('buyer','/orders/order/items/item-0/warehouse',receipt,'POST')).status,200);
  assert.equal((await request('buyer','/orders/order/items/item-0/warehouse',receipt,'POST')).status,200);
  const row=db.prepare("SELECT quantity,shipped_quantity,received_quantity FROM order_items WHERE id='item-0'").get();
  assert.deepEqual({...row},{quantity:5,shipped_quantity:0,received_quantity:2});
  assert.equal((await request('buyer','/orders/order/items/item-0/warehouse',{...receipt,quantity:4,requestId:'early-receipt-00002'},'POST')).status,409);
  assert.equal((await request('buyer','/orders/order/items/item-0/warehouse',{...receipt,action:'stocked',requestId:'early-stocked-00001'},'POST')).status,200);
  db.exec("UPDATE purchase_orders SET archived_at='2026-09-03' WHERE id='order'");
  assert.equal((await request('buyer','/orders/order/items/item-1/acceptance',accept,'POST')).status,404);
  assert.equal((await request('buyer','/orders/order/items/item-1/warehouse',{...receipt,requestId:'early-receipt-00003'},'POST')).status,409);
});

test('admin photo deletion preserves history, resets review and excludes removed evidence', async () => {
  const {db,request,objects}=fixture();
  db.exec("INSERT INTO staff_roles VALUES ('buyer','admin')");
  const form = new FormData(); form.set('kind','production_photo'); form.set('itemId','item-0');
  form.set('file',new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64')],'wrong.png',{type:'image/png'}));
  const upload=await request('buyer','/orders/order/attachments',form,'POST'); assert.equal(upload.status,201);
  const {attachmentId}=await upload.json();
  assert.equal((await request('buyer','/orders/order/items/item-0/acceptance',{decision:'approved',revision:1},'POST')).status,200);
  const count=objects.size;
  assert.equal((await request('vendor','/attachments/'+attachmentId,undefined,'DELETE')).status,403);
  assert.equal((await request('buyer','/attachments/'+attachmentId,undefined,'DELETE')).status,200);
  assert.equal((await request('buyer','/attachments/'+attachmentId,undefined,'DELETE')).status,200);
  assert.equal(objects.size,count);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_acceptances').get().n,1);
  assert.deepEqual({...db.prepare("SELECT acceptance_status,production_revision FROM order_items WHERE id='item-0'").get()},{acceptance_status:'pending',production_revision:2});
  const data=await (await request('buyer','/dashboard',undefined,'GET')).json();
  assert.ok(!data.orders[0].attachments.some(a=>a.id===attachmentId));
  assert.equal((await request('buyer','/attachments/'+attachmentId,undefined,'GET')).status,200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM order_events WHERE event_type='photo_deleted'").get().n,1);
  db.exec("UPDATE purchase_orders SET status='in_production' WHERE id='order'");
  assert.equal((await request('buyer','/orders/order/items/item-0/production',{workflowStage:'production_complete'},'PATCH')).status,409);
  assert.equal((await request('buyer','/orders/order/attachments',form,'POST')).status,201);
});

test('procurement with supplier operations permission can delete real photos and enter tracking number', async () => {
  const {db,request}=fixture();
  db.exec("INSERT INTO staff_permissions(user_id,supplier_operations) VALUES ('buyer',1)");
  const photoForm=new FormData();
  photoForm.set('kind','production_photo'); photoForm.set('itemId','item-0');
  photoForm.set('file',new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64')],'real.png',{type:'image/png'}));
  const upload=await request('buyer','/orders/order/attachments',photoForm,'POST');
  assert.equal(upload.status,201);
  const {attachmentId}=await upload.json();
  assert.equal((await request('buyer','/attachments/'+attachmentId,undefined,'DELETE')).status,200);
  assert.equal(db.prepare("SELECT deleted_by FROM attachments WHERE id=?").get(attachmentId).deleted_by,'buyer');

  db.exec("INSERT INTO attachments (id,order_id,item_id,kind,file_name,content_type,r2_key,uploaded_by,created_at) SELECT 'shipment-real-'||id,order_id,id,'production_photo','real.png','image/png','shipment-real-'||id,'buyer','2026-09-03' FROM order_items WHERE order_id='order'; UPDATE order_items SET workflow_stage='ready_to_ship' WHERE order_id='order'; UPDATE order_items SET acceptance_status='approved' WHERE order_id='order'; UPDATE purchase_orders SET status='ready_to_ship' WHERE id='order'");
  const shipment=new FormData();
  for(const [key,value] of Object.entries({items:JSON.stringify([{itemId:'item-0',quantity:1}]),shippedAt:'2026-09-05',quantity:'1',isComplete:'false',carrier:'顺丰',trackingNumber:'SF-TEST-001',boxCount:'1'})) shipment.set(key,value);
  shipment.append('deliveryNote',new File(['%PDF-test'],'note.pdf',{type:'application/pdf'}));
  const shipped=await request('buyer','/orders/order/shipments',shipment,'POST');
  assert.equal(shipped.status,201,await shipped.text());
  assert.equal(db.prepare("SELECT tracking_number FROM shipment_records ORDER BY created_at DESC LIMIT 1").get().tracking_number,'SF-TEST-001');
});

test('procurement can ship an accepted ready item directly from its product node', async () => {
  const {db,request}=fixture();
  db.exec("INSERT INTO staff_permissions(user_id,supplier_operations) VALUES ('buyer',1); INSERT INTO attachments (id,order_id,item_id,kind,file_name,content_type,r2_key,uploaded_by,created_at) VALUES ('direct-real','order','item-0','production_photo','real.png','image/png','direct-real','buyer','2026-09-03'); UPDATE order_items SET workflow_stage='ready_to_ship' WHERE id='item-0'; UPDATE order_items SET acceptance_status='approved' WHERE id='item-0'; UPDATE purchase_orders SET status='pending_confirmation' WHERE id='order'");
  const shipment=new FormData();
  for(const [key,value] of Object.entries({items:JSON.stringify([{itemId:'item-0',quantity:5}]),shippedAt:'2026-09-05',quantity:'5',isComplete:'false',carrier:'顺丰',trackingNumber:'SF-DIRECT-001',boxCount:'1'})) shipment.set(key,value);
  shipment.append('deliveryNote',new File(['%PDF-test'],'note.pdf',{type:'application/pdf'}));
  const response=await request('buyer','/orders/order/shipments',shipment,'POST');
  assert.equal(response.status,201,await response.text());
  assert.equal(db.prepare("SELECT tracking_number FROM shipment_records WHERE order_id='order'").get().tracking_number,'SF-DIRECT-001');
  assert.equal(db.prepare("SELECT workflow_stage FROM order_items WHERE id='item-0'").get().workflow_stage,'shipment_complete');
});

test('admin can perform supplier operations as themselves without bypassing workflow guards', async () => {
  const {db, request} = fixture();
  db.exec("INSERT INTO staff_roles VALUES ('buyer','admin')");
  assert.equal((await request('buyer','/orders/order/confirm',{promisedShipDate:'2026-09-20'},'POST')).status,200);
  assert.equal(db.prepare("SELECT delivery_actor_id FROM purchase_orders WHERE id='order'").get().delivery_actor_id,'buyer');
  assert.equal((await request('buyer','/orders/order/delivery-estimate',{estimatedShipDate:'2026-09-25',reason:'管理员代录供应商更新',revision:1})).status,200);
  assert.equal((await request('buyer','/orders/order/progress',{note:'管理员代录生产说明'},'POST')).status,200);
  assert.equal((await request('buyer','/orders/order/production-complete',{},'POST')).status,409);
  assert.equal((await request('buyer','/orders/order/shipments',new FormData(),'POST')).status,409);
  db.exec("INSERT INTO attachments (id,order_id,item_id,kind,file_name,content_type,r2_key,uploaded_by,created_at) SELECT 'real-' || id,order_id,id,'production_photo','real.png','image/png','real-' || id,'vendor','2026-09-03' FROM order_items WHERE order_id='order'");
  db.exec("UPDATE order_items SET workflow_stage='production_complete' WHERE order_id='order'; UPDATE order_items SET acceptance_status='approved' WHERE order_id='order'");
  assert.equal((await request('buyer','/orders/order/production-complete',{},'POST')).status,200);
  const revision = db.prepare("SELECT production_revision FROM order_items WHERE id='item-0'").get().production_revision;
  assert.equal((await request('buyer','/orders/order/items/item-0/acceptance',{decision:'approved',reason:'',revision},'POST')).status,200);
  const shipment = new FormData();
  for (const [key,value] of Object.entries({items:JSON.stringify([{itemId:'item-0',quantity:1}]),shippedAt:'2026-09-03',quantity:'1',isComplete:'false',carrier:'测试物流',trackingNumber:'ADMIN-TEST',boxCount:'1'})) shipment.set(key,value);
  shipment.append('deliveryNote',new File(['%PDF-test'],'note.pdf',{type:'application/pdf'}));
  const shipmentResponse = await request('buyer','/orders/order/shipments',shipment,'POST');
  assert.equal(shipmentResponse.status,201,await shipmentResponse.text());
  assert.equal(db.prepare("SELECT shipped_quantity FROM order_items WHERE id='item-0'").get().shipped_quantity,1);
  db.exec("UPDATE staff_roles SET role='purchaser' WHERE user_id='buyer'");
  assert.equal((await request('buyer','/orders/order/delivery-estimate',{estimatedShipDate:'2026-09-26',reason:'不应允许',revision:2})).status,403);
  assert.equal((await request('buyer','/orders/order/shipments',new FormData(),'POST')).status,403);
});

test('procurement can upload per-product real photos while awaiting confirmation without changing production status', async () => {
  const {db,request} = fixture();
  db.exec("UPDATE purchase_orders SET status='pending_confirmation' WHERE id='order'");
  const form = new FormData();
  form.set('kind','production_photo'); form.set('itemId','item-0');
  form.set('file',new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64')],'real.png',{type:'image/png'}));
  assert.equal((await request('buyer','/orders/order/attachments',form,'POST')).status,201);
  assert.equal(db.prepare("SELECT status FROM purchase_orders WHERE id='order'").get().status,'pending_confirmation');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM attachments WHERE item_id='item-0' AND kind='production_photo'").get().n,1);
});

test('office sees all business data but cannot mutate or download forms; engineering has no amounts', async () => {
  const {db, request} = fixture();
  db.exec("INSERT INTO staff_roles VALUES ('buyer','office')");
  for (const path of ['/dashboard','/finance','/staff']) assert.equal((await request('buyer',path,undefined,'GET')).status,200);
  const data = await (await request('buyer','/dashboard',undefined,'GET')).json();
  assert.equal(data.orders[0].items[0].unit_price,10);
  assert.ok(data.suppliers.length);
  for (const [path,method] of [['/orders','POST'],['/orders/order','DELETE'],['/orders/order/internal','PATCH'],['/orders/order/items/item-0/warehouse','POST'],['/orders/order/financial-entries','POST'],['/staff','POST'],['/suppliers/supplier-sp-1001','PATCH']]) {
    assert.equal((await request('buyer',path,{},method)).status,403);
  }
  for (const path of ['/attachments/file','/shipment-attachments/file']) assert.equal((await request('buyer',path,undefined,'GET')).status,403);
  db.exec("UPDATE staff_roles SET role='engineering' WHERE user_id='buyer'");
  const safe = await (await request('buyer','/dashboard',undefined,'GET')).json();
  assert.equal(safe.orders[0].items[0].unit_price,undefined);
  assert.equal(safe.orders[0].commercial_terms,undefined);
  for (const path of ['/finance','/staff','/attachments/file','/shipment-attachments/file']) assert.equal((await request('buyer',path,undefined,'GET')).status,403);
  assert.equal((await request('buyer','/orders/order/items/item-0/warehouse',{action:'received'},'POST')).status,403);
  assert.equal((await request('boss','/staff',{name:'old',email:'old@example.test',password:'test-password',role:'department'},'POST')).status,400);
  for (const role of ['office','engineering']) assert.equal((await request('boss','/staff',{name:role,email:role+'@example.test',password:'test-password',role},'POST')).status,201);
});
