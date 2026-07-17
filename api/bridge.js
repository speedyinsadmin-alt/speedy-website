// /api/bridge — generate a HawkSoft import file (.tt2x) from extracted values.
// POST { fields } with x-admin-key. v1: Personal Auto (AUTOP), dynamic drivers/vehicles.
// Logic mirrors the Python reference generator that was validated against multiple shapes.
import { readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(process.cwd(), 'api');
function load(name){ return readFileSync(join(DIR, name), 'utf8'); }

function esc(s){ return String(s==null?'':s).replace(/[<>&]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
function iso(d){ const m=String(d==null?'':d).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m?`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`:''; }

// set text of <tag>...</tag>. onlyEmpty=true fills just <tag></tag>. all=false → first only.
function setTag(block, tag, val, all=false, onlyEmpty=false){
  if(val==null || String(val).trim()==='') return block;
  const inner = onlyEmpty ? '' : '[\\s\\S]*?';
  const re = new RegExp('(<'+tag+'>)'+inner+'(</'+tag+'>)', all?'g':'');
  return block.replace(re, (m,a,b)=> a+esc(val)+b);
}

export default async function handler(req, res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'POST only'});
  const KEY = process.env.ADMIN_API_KEY;
  if(!KEY) return res.status(500).json({ok:false,error:'ADMIN_API_KEY not set'});
  if((req.headers['x-admin-key']||'')!==KEY) return res.status(401).json({ok:false,error:'Invalid or missing API key'});

  let SKELETON, DRIVER_T, VEH_T, LOC_T, DV_T, HEADER;
  try{
    SKELETON=load('_bridge_skeleton.xml'); DRIVER_T=load('_bridge_driver.xml');
    VEH_T=load('_bridge_veh.xml'); LOC_T=load('_bridge_loc.xml');
    DV_T=load('_bridge_dv.xml'); HEADER=load('_bridge_header.txt');
  }catch(e){ return res.status(500).json({ok:false,error:'Bridge templates missing on server'}); }

  const f = (req.body&&req.body.fields)||{};
  const ins=f.insured||{}, pol=f.policy||{};
  const drivers = (Array.isArray(f.drivers)&&f.drivers.length) ? f.drivers
    : [{first:ins.firstName,last:ins.lastName,dob:ins.dob}];
  const vehicles = (Array.isArray(f.vehicles)&&f.vehicles.length) ? f.vehicles
    : (f.vehicle&&f.vehicle.description ? [{desc:f.vehicle.description,vin:f.vehicle.vin}] : []);
  const addr = {address1:ins.address1,city:ins.city,zip:ins.zip,state:ins.state||'CA'};

  const buildDriver=(i,d)=>{
    let b = DRIVER_T.replace('id="Drv1"', 'id="Drv'+i+'"');
    b=setTag(b,'Surname',d.last,true,true); b=setTag(b,'GivenName',d.first,true,true);
    b=setTag(b,'BirthDt',iso(d.dob),true,true);
    b=setTag(b,'DriversLicenseNumber',d.dl,true,true); b=setTag(b,'LicensePermitNumber',d.dl,true,true);
    return b;
  };
  const buildVeh=(i,drvRef,garRef,v)=>{
    let b = VEH_T.replace('id="Veh1"','id="Veh'+i+'"')
                 .replace('LocationRef="Gar1"','LocationRef="'+garRef+'"')
                 .replace('RatedDriverRef="Drv1"','RatedDriverRef="'+drvRef+'"');
    b=setTag(b,'VehIdentificationNumber',v.vin);
    const m=String(v.desc||'').match(/(\d{4})\s+([A-Za-z\-]+)\s+(.*)/);
    if(m){ b=setTag(b,'ModelYear',m[1]); b=setTag(b,'Manufacturer',m[2].toUpperCase()); b=setTag(b,'Model',m[3].toUpperCase()); }
    return b;
  };
  const buildLoc=(i,a)=>{
    let b=LOC_T.replace('id="Gar1"','id="Gar'+i+'"');
    b=setTag(b,'Addr1',a.address1); b=setTag(b,'City',a.city); b=setTag(b,'PostalCode',a.zip);
    b=setTag(b,'StateProvCd',a.state,true);
    return b;
  };
  const buildDV=(di,vi)=> DV_T.replace('DriverRef="Drv1"','DriverRef="Drv'+di+'"').replace('VehRef="Veh1"','VehRef="Veh'+vi+'"');

  let drvXml='', vehXml='', locXml='', dvXml='';
  drivers.forEach((d,i)=> drvXml+=buildDriver(i+1,d));
  vehicles.forEach((v,i)=>{
    const di=Math.min(i+1, drivers.length);
    vehXml+=buildVeh(i+1,'Drv'+di,'Gar'+(i+1),v);
    locXml+=buildLoc(i+1,addr);
    dvXml +=buildDV(di,i+1);
  });

  let x = SKELETON
    .replace('@@DRIVERS@@',drvXml).replace('@@VEHICLES@@',vehXml)
    .replace('@@LOCATIONS@@',locXml).replace('@@DRIVERVEHS@@',dvXml);

  x = setTag(x,'PolicyNumber', pol.policyNumber);
  if(pol.effectiveDate){ const e=iso(pol.effectiveDate); x=x.replace(/<EffectiveDt>[^<]*<\/EffectiveDt>/, '<EffectiveDt>'+e+'</EffectiveDt>'); }
  if(pol.expirationDate){ const e=iso(pol.expirationDate); x=x.replace(/<ExpirationDt>[^<]*<\/ExpirationDt>/, '<ExpirationDt>'+e+'</ExpirationDt>'); }
  // top-level insured — fill only still-empty tags so per-driver values are preserved
  x=setTag(x,'Surname',ins.lastName,true,true); x=setTag(x,'GivenName',ins.firstName,true,true);
  x=setTag(x,'Addr1',ins.address1,true,true); x=setTag(x,'City',ins.city,true,true);
  x=setTag(x,'PostalCode',ins.zip,true,true); x=setTag(x,'EmailAddr',ins.email,true,true);
  x=setTag(x,'PhoneNumber',ins.phone,true,true);

  let h = HEADER
    .replace(/^insured::.*$/m,'insured::'+((ins.firstName||'')+' '+(ins.lastName||'')).trim().toUpperCase())
    .replace(/^exportdatetime::.*$/m,'exportdatetime::'+new Date().toLocaleString('en-US'))
    .replace(/^testtransaction::.*$/m,'testtransaction::0');

  const filename = 'SpeedyIntake_'+String(pol.policyNumber||'draft').replace(/[^A-Za-z0-9\-]/g,'')+'.tt2x';
  return res.status(200).json({ ok:true, fileText: h+x, filename });
}
