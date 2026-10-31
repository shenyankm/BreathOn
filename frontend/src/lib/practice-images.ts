import { drugs } from './drugs'
export { default as doctorIllustration } from '@/assets/practice/doctor-illustration.png'

const images = import.meta.glob<string>('../assets/library/innovent/*', { eager: true, query: '?url', import: 'default' })
export function drugImage(drug: { name: string; brand: string } | undefined) {
  const entry = drug && drugs.find(item => item.name === drug.name && item.brand === drug.brand)
  return entry ? { src: images[`../assets/library/innovent/${entry.image}`], label: entry.imageLabel ?? '药品图片' } : undefined
}
