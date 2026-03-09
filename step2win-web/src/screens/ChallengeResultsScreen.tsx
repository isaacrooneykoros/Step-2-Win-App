import { useParams, useNavigate } from 'react-router-dom'
import { useQuery }    from '@tanstack/react-query'
import { ChevronLeft, Info } from 'lucide-react'
import { challengesService } from '../services/api/challenges'

const MEDALS = ['🥇', '🥈', '🥉']

const METHOD_LABELS: Record<string, string> = {
  proportional:    'Proportional split',
  dead_heat:       'Tie — prize split',
  tiebreaker:      'Tiebreaker win',
  refund:          'Full refund',
  no_payout:       'Did not qualify',
}

export default function ChallengeResultsScreen() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, isLoading } = useQuery({
    queryKey: ['challenges', 'results', id],
    queryFn:  () => challengesService.getChallengeResults(Number(id)),
    enabled:  !!id,
  })

  if (isLoading || !data) return (
    <div className="min-h-screen flex items-center justify-center"
      style={{ background: '#F8F9FB' }}>
      <div className="w-8 h-8 border-2 border-[#4F9CF9] border-t-transparent
                      rounded-full animate-spin" />
    </div>
  )

  const { challenge, summary, my_result, leaderboard } = data
  const isRefund = summary.is_refund

  return (
    <div className="min-h-screen pb-12" style={{ background: '#F8F9FB' }}>

      {/* ── Header ── */}
      <div className="px-4 pt-6 pb-4 flex items-center gap-3">
        <button onClick={() => navigate(-1)}
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: '#FFF', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <ChevronLeft size={20} color="#111827" />
        </button>
        <div>
          <h1 className="text-[#111827] text-lg font-bold">{challenge.name}</h1>
          <p className="text-[#9CA3AF] text-xs">Final Results</p>
        </div>
      </div>

      {/* ── My result hero card ── */}
      {my_result && (
        <div className="mx-4 mb-4 rounded-2xl p-4"
          style={{
            background: my_result.payout_kes > '0'
              ? 'linear-gradient(135deg, #34D399 0%, #10B981 100%)'
              : isRefund
              ? 'linear-gradient(135deg, #FBBF24 0%, #F59E0B 100%)'
              : '#F9FAFB',
            boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          }}>
          <p className="text-white text-xs font-semibold mb-1 opacity-80">
            {isRefund ? 'REFUNDED' : my_result.payout_kes > '0' ? 'YOU WON' : 'NOT QUALIFIED'}
          </p>
          <p className="text-white font-bold"
            style={{ fontSize: 32, fontFamily: 'DM Serif Display, serif' }}>
            KES {Number(my_result.payout_kes).toLocaleString()}
          </p>
          <p className="text-white text-sm opacity-80 mt-1">
            {my_result.final_steps.toLocaleString()} steps
            {my_result.final_rank ? ` · Rank #${my_result.final_rank}` : ''}
          </p>

          {/* Tie explanation */}
          {my_result.tied_with_count > 0 && (
            <div className="mt-3 rounded-xl p-3"
              style={{ background: 'rgba(255,255,255,0.2)' }}>
              <div className="flex items-start gap-2">
                <Info size={14} className="text-white mt-0.5 flex-shrink-0" />
                <p className="text-white text-xs leading-relaxed">
                  {my_result.payout_method === 'dead_heat'
                    ? `You tied with ${my_result.tied_with_count} other participant(s). 
                       The prize pool for tied positions was split equally.`
                    : `You tied with ${my_result.tied_with_count} other participant(s). 
                       Tie broken by: ${my_result.tiebreaker_label}.`
                  }
                </p>
              </div>
            </div>
          )}

          {/* Refund explanation */}
          {isRefund && (
            <p className="text-white text-xs opacity-80 mt-2">
              No participants reached the {(challenge.milestone/1000).toFixed(0)}K
              step goal. Entry fees refunded in full.
            </p>
          )}
        </div>
      )}

      {/* ── Summary stats ── */}
      <div className="grid grid-cols-3 gap-2 mx-4 mb-4">
        {[
          { label: 'Participants', value: summary.total_participants },
          { label: 'Qualified',    value: summary.qualified_count },
          { label: 'Prize Pool',   value: `KES ${Number(challenge.net_pool).toLocaleString()}` },
        ].map(s => (
          <div key={s.label} className="rounded-xl p-3 text-center"
            style={{ background: '#FFF', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <p className="text-[#111827] text-sm font-bold">{s.value}</p>
            <p className="text-[#9CA3AF] text-xs">{s.label}</p>
          </div>
        ))}
      </div>

      {/* ── Leaderboard ── */}
      <div className="mx-4 rounded-2xl overflow-hidden"
        style={{ background: '#FFF', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div className="px-4 py-3" style={{ borderBottom: '1px solid #F3F4F6' }}>
          <p className="text-[#111827] text-sm font-bold">Final Leaderboard</p>
        </div>

        {leaderboard.map((result: any, i: number) => (
          <div key={result.username}
            className={`px-4 py-3.5 ${i < leaderboard.length - 1
              ? 'border-b border-[#F3F4F6]' : ''}`}
            style={{
              background: result.username === my_result?.username
                ? '#F0FDF4' : undefined
            }}>

            <div className="flex items-center gap-3">
              {/* Rank */}
              <div className="w-8 text-center flex-shrink-0">
                {result.final_rank && result.final_rank <= 3
                  ? <span className="text-xl">{MEDALS[result.final_rank - 1]}</span>
                  : <span className="text-[#9CA3AF] text-sm font-bold">
                      {result.final_rank || '—'}
                    </span>
                }
              </div>

              {/* Avatar initials */}
              <div className="w-9 h-9 rounded-full flex items-center justify-center
                              text-white text-xs font-bold flex-shrink-0"
                style={{ background: result.payout_kes > '0' ? '#4F9CF9' : '#D1D5DB' }}>
                {result.username.slice(0, 2).toUpperCase()}
              </div>

              {/* Name + details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <p className="text-[#111827] text-sm font-bold truncate">
                    {result.username}
                    {result.username === my_result?.username && (
                      <span className="text-[#4F9CF9]"> (you)</span>
                    )}
                  </p>
                  {result.qualified && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full
                                     text-white bg-[#34D399] flex-shrink-0">
                      ✓ QLD
                    </span>
                  )}
                </div>
                <p className="text-[#9CA3AF] text-xs">
                  {result.final_steps.toLocaleString()} steps
                  {result.tied_with_count > 0 && (
                    <span className="text-[#FBBF24]">
                      {' '}· tied ×{result.tied_with_count + 1}
                    </span>
                  )}
                </p>

                {/* Tie explanation inline */}
                {result.tied_with_count > 0 && result.tiebreaker_label && (
                  <p className="text-[#9CA3AF] text-xs mt-0.5 italic">
                    {result.payout_method === 'dead_heat'
                      ? 'Prize split equally'
                      : `Order: ${result.tiebreaker_label}`}
                  </p>
                )}
              </div>

              {/* Payout */}
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-bold"
                  style={{ color: result.payout_kes > '0' ? '#34D399' : '#9CA3AF' }}>
                  {result.payout_method === 'refund'
                    ? 'Refunded'
                    : result.payout_kes > '0'
                    ? `KES ${Number(result.payout_kes).toLocaleString()}`
                    : '—'
                  }
                </p>
                <p className="text-[#9CA3AF] text-xs">
                  {METHOD_LABELS[result.payout_method] || result.payout_method}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

    </div>
  )
}
