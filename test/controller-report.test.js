'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../lib/controller');
const { BridgeError } = require('../lib/errors');
const { overviewReportScreen, reportScreen, POINTS, NOTICE, LABELS } = require('./support/report-fixtures.cjs');
const { chargingSettingsScreen } = require('./support/charging-fixtures.cjs');
const { nativeObservationFromXml } = require('./support/charging-mode-fixtures.cjs');
const MARKER = 'Ihr Fahrzeug: Testwagen. ';

class ReportApp {
    constructor(options = {}) {
        this.page='overview'; this.lower=false; this.position='top'; this.calls=[];
        this.versionValue='4.8.1'; this.options={}; this.deadline=null;
        Object.assign(this,options);
    }
    async connect(){this.calls.push(['connect']);if(this.connectGate)await this.connectGate;}
    async version(){this.calls.push(['version']);if(this.beforeVersion)await this.beforeVersion();return this.versionValue;}
    async launch(){this.calls.push(['launch']);}
    async departureView(){
        const xml=await this.dump();this.homeSnapshot=Object.freeze(nativeObservationFromXml(xml));
        return {xml,observation:this.homeSnapshot};
    }
    async departureAction(request){
        assert.equal(request.snapshot,this.homeSnapshot);assert.equal(request.action,'scrollBackward');
        assert.equal(request.header,'Ihr Fahrzeug: Testwagen. Gerade synchronisiert');
        this.calls.push(['homeNativeAction','scrollBackward']);this.lower=false;
        const xml=await this.dump();
        return {beforeMatched:true,actionAttempted:true,actionAccepted:true,success:true,errorCode:null,postRead:{xml,observation:nativeObservationFromXml(xml)}};
    }
    async dump(){
        if(this.beforeDump)await this.beforeDump();
        this.calls.push(['read',this.page,this.position]);
        if(this.page==='overview') {
            const view=overviewReportScreen({lower:this.lower});
            return this.wrongVehicle?view.replace('Ihr Fahrzeug: Testwagen.','Ihr Fahrzeug: Anderes Auto.'):view;
        }
        if(this.page==='vehicleReport')return reportScreen({position:this.position,...this.options,...(this.missingFooter?{notice:null}:{})});
        if(this.page==='vehicleSettings')return chargingSettingsScreen({dirty:true});
        return '<hierarchy><node package="com.volkswagen.weconnect" class="android.view.View" resource-id="unknown" enabled="true" bounds="[0,0][1000,1500]"/></hierarchy>';
    }
    async swipe(gesture){
        this.calls.push(['swipe',this.page,{...gesture}]);
        if(this.page==='overview'){this.lower=gesture.y2<gesture.y1;return;}
        if(this.page==='vehicleReport') {this.position=gesture.y2<gesture.y1?'bottom':'top';if(this.afterScroll)await this.afterScroll();return;}
        throw new Error('Unexpected navigation gesture');
    }
    async tap(x,y){
        this.calls.push(['tap',this.page,x,y]);
        if(this.page==='overview'&&this.lower&&x===POINTS.open.x&&y===POINTS.open.y){this.page='vehicleReport';if(!this.retainPosition)this.position='top';return;}
        if(this.page==='vehicleReport'&&x===POINTS.back.x&&y===POINTS.back.y){this.page='overview';if(this.afterClose)await this.afterClose();return;}
        throw new Error('Vehicle-affecting or unknown control must never be touched');
    }
    async back(){throw new Error('Unscoped Android Back is outside this read-only report flow');}
    async nativeView(){throw new Error('Native vehicle-setting geometry must never be requested');}
}
function setup(options={},config={}) {
    const phone=new ReportApp(options),clock={value:1700000000000};
    const store={reservations:0,writes:0,async reserveCommand(){this.reservations++;},async write(){this.writes++;}};
    const controller=new Controller({phone,store,config:{approvedAppVersion:'4.8.1',vehicleMarker:{contentDescPrefix:MARKER},modeTitles:['Klimatisierung'],allowWrites:false,commandTimeoutSeconds:300,outcomeTimeoutSeconds:120,cooldownSeconds:60,...config},now:()=>clock.value,sleep:async ms=>{clock.value+=ms;}});
    return {phone,store,controller,clock};
}
async function rejects(promise,code){await assert.rejects(promise,error=>error instanceof BridgeError&&error.code===code&&!error.message.includes('SECRET'));}
function readOnly(phone,store){
    assert.equal(store.reservations,0);assert.equal(store.writes,0);
    for(const call of phone.calls.filter(call=>call[0]==='tap'))assert.ok(call[1]==='overview'&&call[2]===POINTS.open.x&&call[3]===POINTS.open.y||call[1]==='vehicleReport'&&call[2]===POINTS.back.x&&call[3]===POINTS.back.y);
}

test('read-only report collects all pages and returns app data without a vehicle action or preference access',async()=>{
    const {controller,phone,store}=setup();
    const result=await controller.execute('vehicleReportStatus',{targetTemperature:'invalid unused',targetSettings:{invalid:true},targetCharging:{invalid:true}});
    assert.equal(result.domain,'vehicleReport');assert.equal(result.appVersion,'4.8.1');assert.equal(result.vehicleConfirmed,false);
    assert.equal(result.source,'volkswagen_android_app');assert.equal(result.observedAt,'2023-11-14T22:13:20.000Z');
    assert.equal(result.vehicleReport.odometerKm,12345);assert.equal(result.vehicleReport.nextServiceDays,321);
    assert.equal(result.vehicleReport.summary,'Keine Meldungen');assert.equal(result.vehicleReport.hasMessages,false);assert.equal(result.vehicleReport.messageCount,0);
    assert.equal(result.vehicleReport.synchronizationText,'Synchronisiert: Vor 2 h 15 min');assert.equal(result.vehicleReport.notice,NOTICE);
    assert.deepEqual(Object.keys(result.vehicleReport.categories),Object.keys(LABELS));
    for(const category of Object.values(result.vehicleReport.categories))assert.equal(category.status,'no_messages');
    assert.equal(phone.page,'overview');assert.equal(phone.deadline,null);assert.equal(controller.busy,false);readOnly(phone,store);
});

test('a previously open report is closed through its own header and a retained lower position is normalized',async()=>{
    const {controller,phone,store}=setup({page:'vehicleReport',position:'bottom',retainPosition:true});
    const result=await controller.execute('vehicleReportStatus');assert.equal(result.vehicleReport.odometerKm,12345);
    assert.ok(phone.calls.some(call=>call[0]==='swipe'&&call[1]==='vehicleReport'&&call[2].y2>call[2].y1));readOnly(phone,store);
});

test('a read dry run cannot synchronize or change any vehicle setting',async()=>{
    const {controller,phone,store}=setup();const result=await controller.execute('vehicleReportStatus',{dryRun:true});
    assert.equal(result.vehicleReport.hasMessages,false);readOnly(phone,store);
});

test('a complete absence of the report row has a bounded search and no taps',async()=>{
    const {controller,phone}=setup();phone.dump=async()=>overviewReportScreen();
    await rejects(controller.execute('vehicleReportStatus'),'target_unavailable');
    assert.equal(phone.calls.filter(call=>call[0]==='swipe').length,3);assert.equal(phone.calls.filter(call=>call[0]==='tap').length,0);
});

test('wrong vehicle and unapproved app versions cannot open the report',async()=>{
    const wrong=setup({wrongVehicle:true});await assert.rejects(wrong.controller.execute('vehicleReportStatus'),error=>error instanceof BridgeError&&/vehicle/.test(error.code));
    assert.equal(wrong.phone.calls.filter(call=>call[0]==='tap').length,0);
    const version=setup({versionValue:'999.0'});await rejects(version.controller.execute('vehicleReportStatus'),'version_not_approved');assert.equal(version.phone.calls.filter(call=>call[0]==='tap').length,0);
});

test('vehicle verification is repeated after returning from the report',async()=>{
    const {controller,phone}=setup();phone.afterClose=()=>{phone.wrongVehicle=true;};
    await assert.rejects(controller.execute('vehicleReportStatus'),error=>error instanceof BridgeError&&/vehicle/.test(error.code));assert.equal(phone.page,'overview');
});

test('a missing final footer produces no partial success and stops at repeated page content',async()=>{
    const {controller,phone,store}=setup({missingFooter:true});await rejects(controller.execute('vehicleReportStatus'),'report_incomplete');
    assert.ok(phone.calls.filter(call=>call[0]==='swipe'&&call[1]==='vehicleReport').length<=2);assert.equal(controller.busy,false);readOnly(phone,store);
});

test('all seven category rows are required before reporting complete data',async()=>{
    const categories=Object.fromEntries(Object.entries(LABELS).filter(([key])=>key!=='tires').map(([key,[,label]])=>[key,{label,texts:[]}]));
    const {controller}=setup({options:{categories}});await rejects(controller.execute('vehicleReportStatus'),'report_incomplete');
});

test('a changed visible report before navigation is rejected rather than overwritten',async()=>{
    const {controller,phone}=setup();let reportReads=0;
    phone.beforeDump=()=>{if(phone.page==='vehicleReport'&&++reportReads>1)phone.options.odometerText='12.346 km';};
    await rejects(controller.execute('vehicleReportStatus'),'report_changed');
    assert.equal(phone.calls.filter(call=>call[0]==='swipe'&&call[1]==='vehicleReport').length,0);
});

test('overlapping pages with contradictory summaries cannot be combined',async()=>{
    const {controller,phone}=setup();phone.afterScroll=()=>{phone.options.summary='1 Meldung';};
    await rejects(controller.execute('vehicleReportStatus'),'report_changed');
});

test('a delayed old snapshot after scrolling is waited out without repeating the gesture',async()=>{
    const {controller,phone}=setup();const dump=phone.dump.bind(phone),swipe=phone.swipe.bind(phone);let stale=null;
    phone.dump=async()=>{if(stale){const result=stale;stale=null;return result;}return dump();};
    phone.swipe=async gesture=>{const before=phone.page==='vehicleReport'?await dump():null;await swipe(gesture);stale=before;};
    const result=await controller.execute('vehicleReportStatus');assert.equal(result.vehicleReport.odometerKm,12345);
    assert.equal(phone.calls.filter(call=>call[0]==='swipe'&&call[1]==='vehicleReport').length,1);
});

test('changes in the final fresh snapshot cannot be published as a successful older report',async()=>{
    const {controller,phone}=setup();let reportReads=0;
    phone.beforeDump=()=>{if(phone.page==='vehicleReport'&&++reportReads===4)phone.options.summary='1 Meldung';};
    await rejects(controller.execute('vehicleReportStatus'),'report_changed');
    assert.equal(phone.calls.filter(call=>call[0]==='tap'&&call[1]==='vehicleReport').length,0);
});

test('unknown summary text stays unknown while its exact text and category details are retained',async()=>{
    const {controller}=setup({options:{summary:'Status wird ermittelt'}});
    const result=await controller.execute('vehicleReportStatus');assert.equal(result.vehicleReport.hasMessages,null);assert.equal(result.vehicleReport.messageCount,null);
    assert.equal(result.vehicleReport.summary,'Status wird ermittelt');assert.ok(Object.values(result.vehicleReport.categories).every(value=>value.status==='unknown'));
});

test('a manual vehicle-settings draft is never saved or discarded to open the report',async()=>{
    const {controller,phone}=setup({page:'vehicleSettings'});await rejects(controller.execute('vehicleReportStatus'),'unsaved_settings');assert.equal(phone.calls.filter(call=>call[0]==='tap').length,0);
});

test('transport errors cannot leak private report contents or cause an automatic navigation retry',async()=>{
    const {controller,phone}=setup();phone.afterScroll=()=>{throw new Error('SECRET report details');};
    await rejects(controller.execute('vehicleReportStatus'),'internal_error');assert.equal(phone.calls.filter(call=>call[0]==='swipe'&&call[1]==='vehicleReport').length,1);
    assert.equal(controller.busy,false);assert.equal(phone.deadline,null);
});

test('report operations reserve busy synchronously and respect cancellation',async()=>{
    let release;const gate=new Promise(resolve=>{release=resolve;});const {controller,phone}=setup({connectGate:gate});
    const active=controller.execute('vehicleReportStatus');await rejects(controller.execute('vehicleReportStatus'),'busy');
    controller.cancel();release();await rejects(active,'cancelled');assert.equal(controller.busy,false);assert.equal(phone.deadline,null);assert.equal(phone.calls.filter(call=>call[0]==='tap').length,0);
});

test('automatic keep-awake uses one verified connection before any report navigation',async()=>{
    const {controller,phone}=setup({}, {stayAwakeOnCharge:true});
    phone.keepAwake=async()=>{phone.calls.push(['keepAwake']);return {active:true};};
    await controller.execute('vehicleReportStatus');
    assert.equal(phone.calls.filter(call=>call[0]==='connect').length,1);
    assert.equal(phone.calls.filter(call=>call[0]==='keepAwake').length,1);
    assert.ok(phone.calls.findIndex(call=>call[0]==='connect')<phone.calls.findIndex(call=>call[0]==='keepAwake'));
    assert.ok(phone.calls.findIndex(call=>call[0]==='keepAwake')<phone.calls.findIndex(call=>call[0]==='tap'));
});

test('failed keep-awake confirmation prevents all report app input',async()=>{
    const {controller,phone}=setup({}, {stayAwakeOnCharge:true});phone.keepAwake=async()=>({active:false});
    await rejects(controller.execute('vehicleReportStatus'),'phone_setting_failed');
    assert.equal(phone.calls.filter(call=>call[0]==='tap'||call[0]==='swipe').length,0);
});
