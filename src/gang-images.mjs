const CID=/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/;

// Official index hints establish image provenance only, never token membership.
// The image proxy separately pins public DNS, bounds bytes and checks formats.
export function gangImageSources(hint={},address){
 let thumbnail=null,original=null;
 const match=typeof hint.logoThumbUrl==='string'?/^\/thumbs\/(0x[0-9a-f]{40})\.webp(?:\?[a-zA-Z0-9_=.-]+)?$/i.exec(hint.logoThumbUrl):null;
 if(match&&typeof address==='string'&&match[1].toLowerCase()===address.toLowerCase())thumbnail=`https://gang.fun/api${hint.logoThumbUrl}`;
 if(typeof hint.logoUrl==='string'&&hint.logoUrl.length<=2048){
  try{const url=new URL(hint.logoUrl);if(url.protocol==='https:'&&url.hostname==='cdn.gang.fun'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&/^\/ipfs\/[^/]+$/.test(url.pathname)&&CID.test(url.pathname.slice(6)))original=url.href;}catch{}
 }
 return{sourceImageUrl:thumbnail||original,sourceImageFallbackUrl:thumbnail&&original?original:null};
}
