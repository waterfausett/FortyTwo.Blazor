using FortyTwo.Shared.Models;

namespace FortyTwo.Client.Store
{
    public interface IClientStore
    {
        public Domino[] Dominos { get; set; }

    }

    public class ClientStore : IClientStore
    {
        public Domino[] Dominos { get; set; }
    }
}
