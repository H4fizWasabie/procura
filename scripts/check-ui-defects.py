#!/usr/bin/env python3
"""Build the app, then run isolated HTTP regressions. No production data is used."""
import base64, hashlib, hmac, io, json, os, pathlib, socket, sqlite3, subprocess, tempfile, time, urllib.request, urllib.error, zipfile
root = pathlib.Path(__file__).resolve().parents[1]
failures = []
def check(name, fn):
    try:
        fn()
        print('PASS:', name)
    except Exception as e:
        failures.append(name)
        print('FAIL:', name, str(e))
def expect(value, wanted):
    assert value == wanted, (value, wanted)
with tempfile.TemporaryDirectory(prefix='procura-ui-check-') as tmp:
    binary = pathlib.Path(tmp) / 'procura'
    subprocess.run(['go', 'build', '-o', str(binary), '.'], cwd=root, check=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    env = dict(os.environ, PROCURA_DATA_DIR=tmp, PORT=str(port), PROCURA_SECRET='isolated-regression-key', PROCURA_DEMO='0')
    with open(pathlib.Path(tmp)/'server.log', 'w') as log:
        proc = subprocess.Popen([str(binary)], cwd=tmp, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{port}/login', timeout=1); break
                except (OSError, urllib.error.URLError): time.sleep(.1)
            else: raise RuntimeError('app did not start')
            db = sqlite3.connect(pathlib.Path(tmp)/'procura.sqlite')
            for role in ['ADMIN','EDITOR','VIEWER','OTHER']:
                db.execute('INSERT INTO users(email,name,role,pin_hash,auth_version) VALUES(?,?,?,?,0)',(role+'@test.local',role,role,'unused'))
            db.execute("INSERT INTO suppliers(supplier_name) VALUES('Target'),('Other'),('Supplier')")
            db.execute('CREATE TABLE IF NOT EXISTS supplier_item_mappings(id INTEGER PRIMARY KEY, stock_id TEXT, supplier_name TEXT, supplier_item_name TEXT, supplier_uom TEXT)')
            for i in range(65):
                db.execute('INSERT INTO items(stock_id,item_name,supplier_name,category,current_stock,rop,exclude,item_behaviour) VALUES(?,?,?,?,?,?,?,?)',(f'I{i:03}',f'Item {i}','Target' if i<3 else 'Other','Clinic',0,2,0,''))
            db.execute("INSERT INTO purchase_orders(po_id,status,ship_status) VALUES('PO-CHECK','Pending Approval','Pending')")
            db.execute("CREATE TRIGGER reject_score BEFORE INSERT ON supplier_performance WHEN NEW.po_id='PO-FAIL' BEGIN SELECT RAISE(ABORT,'forced save failure'); END")
            db.execute("CREATE TRIGGER reject_status BEFORE UPDATE OF status ON purchase_orders WHEN NEW.status='Void' BEGIN SELECT RAISE(ABORT,'forced status failure'); END")
            db.execute("UPDATE items SET pack_size='12',exclude=1 WHERE stock_id='I002'")
            db.commit()
            def token(role):
                enc=lambda v:base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b'=')
                data=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'email':role+'@test.local','name':role,'role':role,'jti':'0','exp':int(time.time())+600})
                sig=base64.urlsafe_b64encode(hmac.new(env['PROCURA_SECRET'].encode(),data,hashlib.sha256).digest()).rstrip(b'=')
                return (data+b'.'+sig).decode()
            def request(path, body=None, role='ADMIN'):
                req=urllib.request.Request(f'http://127.0.0.1:{port}'+path, data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+token(role),'Content-Type':'application/json'})
                try: res=urllib.request.urlopen(req)
                except urllib.error.HTTPError as e: res=e
                return res.status, res.headers, res.read()
            def inventory():
                status, headers, data=request('/api/inventory?supplier=Target&category=Clinic&low_stock=1&active=1&pageSize=2&page=1')
                rows=json.loads(data); expect(status,200); expect(len(rows),2); expect({r['supplier_name'] for r in rows},{'Target'}); expect(headers.get('X-Has-More'),'false')
                _, headers, data=request('/api/inventory?supplier=Target&pageSize=2&page=2'); expect(len(json.loads(data)),1);expect(headers.get('X-Has-More'),'false')
                _,_,data=request('/api/inventory?stock_id=I001&name=Item+1');expect([r['stock_id'] for r in json.loads(data)],['I001'])
            def anchors():
                _,_,data=request('/api/inventory/detail?stock_id=I002');d=json.loads(data);expect(d.get('pack_size'),'12');expect(str(d.get('exclude')),'1')
            check('item details retain pack and exclusion anchors',anchors)
            check('inventory filters precede pagination and combined field search works',inventory)
            check('missing PO update returns 404',lambda:expect(request('/api/pos/MISSING/status',{'status':'Paid'})[0],404))
            check('failed PO update returns 500',lambda:expect(request('/api/pos/PO-CHECK/status',{'status':'Void'})[0],500))
            check('malformed status returns 400',lambda:expect(request('/api/pos/PO-CHECK/status',{'status':1})[0],400))
            check('unknown status rejected',lambda:expect(request('/api/pos/PO-CHECK/status',{'status':'nonsense'})[0],400))
            score={'po_id':'PO-FAIL','supplier_name':'Supplier','accuracy':4,'speed':3,'quality':5,'comments':'Regression note'}
            check('failed score save returns 500',lambda:expect(request('/api/scorecard',score)[0],500))
            def save_score():
                expect(request('/api/scorecard',dict(score,po_id='PO-CHECK'))[0],200)
                row=db.execute("SELECT supplier_name,comments,weighted_score,rated_by,timestamp FROM supplier_performance WHERE po_id='PO-CHECK'").fetchone()
                expect(row[0],'Supplier');expect(row[1],'Regression note');assert row[2]>0;expect(row[3],'ADMIN@test.local');assert row[4]
            check('score metadata and computed score persist',save_score)
            for role in ['VIEWER','OTHER']:
                check(role+' cannot edit inventory',lambda role=role:expect(request('/api/inventory/I001',{'cost':2},role)[0],403))
                check(role+' cannot freeze analytics',lambda role=role:expect(request('/api/analytics/freeze?year=2026&month=8',{},role)[0],403))
            def edit():
                expect(request('/api/inventory/I001',{'cost':2},'EDITOR')[0],200);expect(db.execute("SELECT cost FROM items WHERE stock_id='I001'").fetchone()[0],2)
            check('editor inventory save persists',edit)
            def export():
                status,headers,data=request('/api/inventory/export?format=xlsx&supplier=Target');expect(status,200);assert 'spreadsheetml' in headers.get('Content-Type','');expect(headers.get('Content-Disposition'),'attachment; filename="items.xlsx"')
                with zipfile.ZipFile(io.BytesIO(data)) as z: assert 'xl/workbook.xml' in z.namelist()
                status,headers,data=request('/api/inventory/export?format=csv&supplier=Target');expect(status,200);expect(len(data.decode().strip().splitlines()),4)
            check('filtered XLSX is a workbook and CSV includes all matching rows',export)
            check('missing anchor save reports 404',lambda:expect(request('/api/inventory/MISSING',{'cost':2})[0],404))
            def status_save():
                expect(request('/api/pos/PO-CHECK/status',{'status':'Delivered','field':'ship'})[0],200)
                expect(db.execute("SELECT status,ship_status FROM purchase_orders WHERE po_id='PO-CHECK'").fetchone(),('Pending Approval','Delivered'))
            check('shipment save preserves approval status',status_save)
            db.execute("INSERT INTO purchase_orders(po_id,supplier,status) VALUES('PO-SCORE','Supplier','Paid')")
            db.execute("INSERT INTO purchase_order_items(po_id,stock_id,item_name,quantity,cost,total) VALUES('PO-SCORE','I001','Item 1',2,3,6)")
            db.commit()
            subprocess.run(['node',str(root/'scripts/check-ui-browser.mjs')],cwd=root,env=dict(os.environ,CHECK_URL=f'http://127.0.0.1:{port}',CHECK_TOKEN=token('ADMIN')),check=True)
            db.close()
        finally:
            proc.terminate();proc.wait(timeout=5)
subprocess.run(['node',str(root/'scripts/check-ui-defects.mjs')],cwd=root,check=True)
assert not failures, failures
