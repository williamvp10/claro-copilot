import { notFound } from 'next/navigation';
import styles from './source.module.css';

type Source = {
  title:string;
  version:string;
  archived:boolean;
  pdf_available:boolean;
  passages:{id:string;page?:number}[];
  sections:{id:string;title:string;text:string}[];
};

export default async function KnowledgeSource({
  params,searchParams
}:{
  params:Promise<{publicacion:string;fuente:string}>;
  searchParams:Promise<{pasaje?:string|string[]}>;
}) {
  const [{publicacion,fuente},{pasaje}]=await Promise.all([params,searchParams]);
  if (!/^[a-f0-9]{64}$/.test(publicacion) || !/^[a-z][a-z0-9-]{0,63}$/.test(fuente)) notFound();
  const origin=process.env.BACKEND_URL;
  if (!origin) notFound();
  const path=`/api/v1/knowledge/sources/${publicacion}/${fuente}`;
  const response=await fetch(new URL(path,origin),{cache:'no-store'});
  if (!response.ok) notFound();
  const source:Source=await response.json();
  const cited=source.passages.find(item=>item.id===pasaje);
  const pdf=`${path}/document${cited?.page ? `#page=${cited.page}` : ''}`;
  const selected=source.sections.find(section=>section.id===cited?.id);
  const sections=selected ? [selected] : source.sections;

  return <main className={styles.viewer}>
    <header>
      <h1>{source.title}</h1>
      <p>{source.version}{source.archived&&' · Versión archivada'}</p>
      {source.pdf_available ? <>
        <a href={pdf} target="_blank" rel="noreferrer">Abrir PDF{cited?.page ? ` en la página ${cited.page}` : ''}</a>
        {' · '}<a href={`${path}/document?download=1`} download>Descargar PDF</a>
      </> : <p>El PDF de esta edición no está disponible en este momento.</p>}
    </header>
    {sections.length>0 ? sections.map(section=><section key={section.id} id={section.id}>
      <h2>{section.title}</h2>
      <p>{section.text}</p>
    </section>) : source.pdf_available && <iframe src={pdf} title={source.title} />}
  </main>;
}
