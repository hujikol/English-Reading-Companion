import type { LearningExplanation } from "../contracts/learning.ts";
import { BTN_SECONDARY, META } from "./styles.ts";

export function ContextExplanation({ result, onUseMeaning }: {
  result: LearningExplanation;
  onUseMeaning?: (meaning: string) => void;
}) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-line bg-accent-soft p-3 text-sm leading-relaxed text-ink">
      {result.sentenceExplanation && <section>
        <h3 className="font-semibold">Sentence meaning</h3>
        <p>{result.sentenceExplanation}</p>
      </section>}
      <section>
        <h3 className="font-semibold">Natural Indonesian sentence</h3>
        <p>{result.naturalTranslation}</p>
      </section>
      {result.contextualMeaning && <section>
        <h3 className="font-semibold">This word here</h3>
        <p>{result.contextualMeaning}</p>
        {result.partOfSpeech && <p className={META}>{result.partOfSpeech}</p>}
        {onUseMeaning && <button type="button" className={`${BTN_SECONDARY} mt-2`} onClick={() => onUseMeaning(result.contextualMeaning!)}>
          Use this meaning
        </button>}
      </section>}
      {!result.contextualMeaning && result.partOfSpeech && <p className={META}>Part of speech: {result.partOfSpeech}</p>}
      {!!result.alternateMeanings?.length && <section>
        <h3 className="font-semibold">Other meanings</h3>
        <ul className="mt-1 space-y-3">
          {result.alternateMeanings.map((alternative, index) => <li key={index} className="border-l-2 border-line pl-2">
            <p className="font-medium">{alternative.meaning}</p>
            <p>{alternative.usage}</p>
            <p className="mt-1 font-read">{alternative.example.english}</p>
            <p className={META}>{alternative.example.indonesian}</p>
          </li>)}
        </ul>
      </section>}
      {result.grammarNote && <section>
        <h3 className="font-semibold">Usage / grammar</h3>
        <p>{result.grammarNote}</p>
      </section>}
      {result.simplerEnglish && <section>
        <h3 className="font-semibold">Simpler English</h3>
        <p className="font-read">{result.simplerEnglish}</p>
      </section>}
      {result.example && <section>
        <h3 className="font-semibold">Another example</h3>
        <p className="font-read">{result.example.english}</p>
        <p>{result.example.indonesian}</p>
      </section>}
      <p className={`${META} border-t border-line pt-2`}>AI suggestion · {result.provider} / {result.model}</p>
    </div>
  );
}
