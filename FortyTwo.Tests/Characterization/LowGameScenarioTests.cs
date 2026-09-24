using System.Collections.Generic;
using System.Threading.Tasks;
using FortyTwo.Shared.Models;
using Xunit;

namespace FortyTwo.Tests.Characterization
{
    public class LowGameScenarioTests
    {
        // p1: all doubles (leads every trick with an unbeatable double under Low,
        //     since Domino.GetSuitValue ranks doubles as 7 - highest of any suit).
        // p2/p4: dominoes chosen so each can legally follow the suit p1 leads.
        // p3: whatever's left - p3 is p1's partner (position parity 0 == 0) and,
        //     per MatchExtensions.SelectNextPlayer's Low skip rule, never gets a turn.
        private static readonly List<(int, int)> DealOrder = new()
        {
            (0,0),(1,1),(2,2),(3,3),(4,4),(5,5),(6,6),          // p1: all doubles
            (0,1),(0,2),(0,3),(0,4),(0,5),(1,2),(1,6),           // p2
            (0,6),(2,5),(3,4),(3,6),(4,5),(4,6),(5,6),           // p3 (bidder's partner - never plays)
            (1,3),(1,4),(1,5),(2,3),(2,4),(2,6),(3,5),           // p4
        };

        [Fact]
        public async Task RunAndWriteFixture()
        {
            var runner = new ScenarioRunner(DealOrder, "low-game");

            var matchId = await runner.CreateAsync("p1");
            await runner.AddPlayerAsync(matchId, "p2", Teams.TeamB);
            await runner.AddPlayerAsync(matchId, "p3", Teams.TeamA);
            await runner.AddPlayerAsync(matchId, "p4", Teams.TeamB);

            // p1 (position First, TeamA) bids highest, everyone else passes.
            // p1's partner is p3 (position Third, also TeamA).
            await runner.BidAsync(matchId, "p1", Bid.Thirty);
            await runner.BidAsync(matchId, "p2", Bid.Pass);
            await runner.BidAsync(matchId, "p3", Bid.Pass);
            await runner.BidAsync(matchId, "p4", Bid.Pass);

            await runner.SetTrumpAsync(matchId, "p1", Suit.Low);

            // Low trump: no domino is ever "of trump suit" (Suit.Low == -2, no domino
            // has a -2 pip), and MatchExtensions.SelectNextPlayer skips the bidder's
            // partner (p3) every time turn order would otherwise land on them. Only
            // p1, p2, and p4 ever play a domino; each trick is full at 3 dominoes
            // (Trick.IsFull under Low), not 4.

            // Trick 1: p1 leads 6-6 (double => led suit Sixes, ranks highest of that suit)
            await runner.PlayDominoAsync(matchId, "p1", 6, 6);
            await runner.PlayDominoAsync(matchId, "p2", 1, 6); // follows suit (has a six)
            await runner.PlayDominoAsync(matchId, "p4", 2, 6); // follows suit (has a six)
            // p1's double wins trick 1; p1 leads trick 2.

            // Trick 2: p1 leads 5-5 (double => led suit Fives)
            await runner.PlayDominoAsync(matchId, "p1", 5, 5);
            await runner.PlayDominoAsync(matchId, "p2", 0, 5); // follows suit (has a five)
            await runner.PlayDominoAsync(matchId, "p4", 3, 5); // follows suit (has a five)
            // p1's double wins trick 2 again.

            runner.WriteFixture();
        }
    }
}
