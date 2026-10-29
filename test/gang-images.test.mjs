import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../src/gang-images.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const ADDRESS='0x23ae21386f5658b923da614384bd281cc77d8120';
const CID='bafkreickg4evngcqiggi7o3rciqjyj2wykcy2iv6mpsi74kfi36wo4gosq',LOGO=`https://cdn.gang.fun/ipfs/${CID}`;

test('Gang source retains an official CDN logo when the merged index has no thumbnail',()=>{
 assert.equal(typeof module.gangImageSources,'function','the image source adapter must exist');
 assert.deepEqual(module.gangImageSources({logoUrl:LOGO,hasLogo:true},ADDRESS),{sourceImageUrl:LOGO,sourceImageFallbackUrl:null});
 assert.deepEqual(module.gangImageSources({},ADDRESS),{sourceImageUrl:null,sourceImageFallbackUrl:null},'true image absence stays unknown');
});

test('matching token thumbnails remain preferred and retain their original official image as a fallback',()=>{
 assert.equal(typeof module.gangImageSources,'function');
 assert.deepEqual(module.gangImageSources({logoThumbUrl:`/thumbs/${ADDRESS}.webp?v=abc123`,logoUrl:LOGO},ADDRESS),{sourceImageUrl:`https://gang.fun/api/thumbs/${ADDRESS}.webp?v=abc123`,sourceImageFallbackUrl:LOGO});
 assert.equal(module.gangImageSources({logoThumbUrl:'/thumbs/0x1111111111111111111111111111111111111111.webp',logoUrl:LOGO},ADDRESS).sourceImageUrl,LOGO,'another token thumbnail cannot substitute this token logo');
});

test('Gang image hints cannot introduce arbitrary hosts, credentialed URLs or malformed content paths',()=>{
 assert.equal(typeof module.gangImageSources,'function');
 for(const logoUrl of ['https://cdn.gang.fun.evil.example/ipfs/'+CID,'https://127.0.0.1/ipfs/'+CID,'http://cdn.gang.fun/ipfs/'+CID,'https://user:pass@cdn.gang.fun/ipfs/'+CID,'https://cdn.gang.fun:8443/ipfs/'+CID,'https://cdn.gang.fun/not-ipfs/'+CID,'https://cdn.gang.fun/ipfs/not-a-cid','https://cdn.gang.fun/ipfs/'+CID+'?url=http://localhost'])assert.equal(module.gangImageSources({logoUrl},ADDRESS).sourceImageUrl,null,logoUrl);
});
