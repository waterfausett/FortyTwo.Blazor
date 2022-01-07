using FortyTwo.Entity.Models;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;

namespace FortyTwo.Server.Services
{
    public interface IMatchValidationService
    {
        IMatchValidationService IsActive(Match match);
        IMatchValidationService IsNotFull(Match match);
        IMatchValidationService IsActive(MatchPlayer match);
        IMatchValidationService IsActive(Game game);
        IMatchValidationService IsActiveTurn(Game game, UserId userId);
        IMatchValidationService IsActiveBidder(Game game, UserId userId);
        IMatchValidationService ValidateBid(Game game, UserId userId, Bid bid);
        IMatchValidationService BiddingComplete(Game game);
        IMatchValidationService IsReadyToPlay(Game game);
        IMatchValidationService HasDomino(Game game, UserId userId, Domino domino);
        IMatchValidationService IsValidDomino(Game game, UserId userId, Domino domino);
        IMatchValidationService IsMatchPlayer(Match match, UserId userId);
        IMatchValidationService IsNotMatchPlayer(Match match, UserId userId);
    }
}
